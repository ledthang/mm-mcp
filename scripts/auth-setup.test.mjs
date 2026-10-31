import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ENDPOINT, CONFIG_QUERY, LOGIN_QUERY, PROOF_QUERY, authPath, main, readInput, setup } from './auth-setup.mjs';

const input = { email: 'fake@example.invalid', password: 'fake-password-only', store: 'b2c_70010_vi' };
const text = JSON.stringify(input);
const token = 'fake-token-only';
const oldAuth = '{"authorization":"Bearer old-fake-token","store":"b2c_70010_vi"}\n';
const config = { recaptchaV3Config: { website_key: '', forms: [] } };
const login = { generateCustomerTokenV2: { token } };
const proof = { customer: { __typename: 'Customer' }, storeConfig: { store_code: input.store } };
const response = data => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'fake_cookie=ignored; Secure' } });
const tests = [];
const test = (name, run) => tests.push({ name, run });

function fakeFetch(replies = [config, login, proof]) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options, body: JSON.parse(options.body) });
      assert.equal(url, ENDPOINT);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Store, input.store);
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers.cookie, undefined);
      assert.equal(options.headers['X-ReCaptcha'], undefined);
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(calls.length <= replies.length, 'Unexpected retry or extra request');
      const reply = replies[calls.length - 1];
      if (reply instanceof Error) throw reply;
      return reply instanceof Response ? reply : response(reply);
    },
  };
}

const root = await fs.mkdtemp(path.join(tmpdir(), 'mm-auth-setup-test-'));
let sequence = 0;
async function fixture(existing = false) {
  const directory = path.join(root, `case-${++sequence}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, 'auth.json');
  if (existing) await fs.writeFile(file, oldAuth, { mode: 0o600 });
  return { directory, file, env: { MM_AUTH_FILE: file } };
}

async function rejected(code, { replies, value = text, fileOps, existing = true } = {}) {
  const target = await fixture(existing);
  const network = fakeFetch(replies);
  await assert.rejects(setup(value, { ...target, ...network, fileOps }), { message: code });
  if (existing) assert.equal(await fs.readFile(target.file, 'utf8'), oldAuth);
  else await assert.rejects(fs.lstat(target.file), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(target.directory), existing ? ['auth.json'] : []);
  return network.calls;
}

test('success uses exact three requests and private compatible storage', async () => {
  const target = await fixture();
  const network = fakeFetch();
  await setup(text, { ...target, ...network });
  assert.deepEqual(network.calls.map(call => call.body), [
    { query: CONFIG_QUERY, variables: {} },
    { query: LOGIN_QUERY, variables: { email: input.email, password: input.password } },
    { query: PROOF_QUERY, variables: {} },
  ]);
  assert.equal(LOGIN_QUERY, 'mutation SignIn($email:String!,$password:String!){generateCustomerTokenV2(email:$email,password:$password){token}}');
  assert.equal(CONFIG_QUERY, 'query AuthSetupConfig{recaptchaV3Config{website_key forms}}');
  assert.equal(PROOF_QUERY, 'query AuthSetupProof{customer{__typename} storeConfig{store_code}}');
  assert.deepEqual(network.calls.map(call => call.headers.Authorization), [undefined, undefined, `Bearer ${token}`]);
  assert.deepEqual(network.calls.map(call => Object.keys(call.headers).sort()), [
    ['Content-Type', 'Store'], ['Content-Type', 'Store'], ['Authorization', 'Content-Type', 'Store'],
  ]);
  const saved = await fs.readFile(target.file, 'utf8');
  assert.deepEqual(JSON.parse(saved), { authorization: `Bearer ${token}`, store: input.store });
  assert.ok(!saved.includes(input.password) && !saved.includes(input.email));
  assert.equal((await fs.stat(target.file)).mode & 0o7777, 0o600);
  assert.equal((await fs.stat(target.directory)).mode & 0o7777, 0o700);
  assert.equal((await fs.stat(target.file)).uid, process.getuid());
});

test('replacement succeeds atomically without temporary files', async () => {
  const target = await fixture(true);
  let renames = 0;
  await setup(text, { ...target, ...fakeFetch(), fileOps: { ...fs, rename: async (source, destination) => {
    assert.equal(await fs.readFile(destination, 'utf8'), oldAuth);
    assert.equal((await fs.stat(source)).mode & 0o7777, 0o600);
    renames++;
    await fs.rename(source, destination);
  } } });
  assert.equal(renames, 1);
  assert.deepEqual(await fs.readdir(target.directory), ['auth.json']);
});

test('other configured CAPTCHA forms do not enable CUSTOMER_LOGIN', async () => {
  const target = await fixture();
  const network = fakeFetch([{ recaptchaV3Config: { website_key: 'fake-site-key', forms: ['CUSTOMER_CREATE'] } }, login, proof]);
  await setup(text, { ...target, ...network });
  assert.equal(network.calls.length, 3);
});

test('path precedence: explicit, XDG, default; missing private parents created', async () => {
  const home = path.join(root, 'fake-home');
  const xdg = path.join(root, 'fake-xdg');
  assert.equal(authPath({ MM_AUTH_FILE: '/tmp/explicit-only', XDG_DATA_HOME: xdg }, home), '/tmp/explicit-only');
  assert.equal(authPath({ XDG_DATA_HOME: xdg }, home), path.join(xdg, 'mm-mcp', 'auth.json'));
  assert.equal(authPath({}, home), path.join(home, '.local/share/mm-mcp/auth.json'));
  for (const env of [{ XDG_DATA_HOME: xdg }, {}]) {
    await setup(text, { env, home, ...fakeFetch() });
    const file = authPath(env, home);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).store, input.store);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o7777, 0o700);
  }
  for (const selected of ['', 'bad\npath']) assert.throws(() => authPath({ MM_AUTH_FILE: selected }), { message: 'STORAGE_UNSAFE' });
});

for (const website_key of ['fake-site-key', '']) {
  test(`CUSTOMER_LOGIN blocks login with ${website_key ? 'present' : 'empty'} key`, async () => {
    const calls = await rejected('CHALLENGE_REQUIRED', { replies: [{ recaptchaV3Config: { website_key, forms: ['CUSTOMER_LOGIN'] } }] });
    assert.equal(calls.length, 1);
  });
}

for (const malformed of [null, {}, { forms: [] }, { website_key: null, forms: [] }, { website_key: '', forms: null },
  { website_key: '', forms: 'CUSTOMER_LOGIN' }, { website_key: '', forms: [null] },
  { website_key: '', forms: ['customer_login'] }, { website_key: '\n', forms: [] }]) {
  test('malformed config fails closed before login', async () => {
    const calls = await rejected('CONFIG_UNVERIFIED', { replies: [{ recaptchaV3Config: malformed }] });
    assert.equal(calls.length, 1);
  });
}

for (const value of ['{', 'null', '[]', '{}', `${text}\n${text}`, JSON.stringify({ ...input, extra: true }),
  ...[{ email: 'invalid' }, { email: 'a\nb@example.invalid' }, { password: '' }, { password: '   ' },
    { password: 'fake\u0000password' }, { password: 'x'.repeat(4097) }, { store: 'b2c_123456789_vi' },
    { store: 'b2c_70010_vi\r\nCookie: bad' }, { email: 42 }, { password: null }].map(change => JSON.stringify({ ...input, ...change })),
  ' '.repeat(16385)]) {
  test('malformed input rejected without requests', async () => {
    const calls = await rejected('INVALID_INPUT', { value });
    assert.equal(calls.length, 0);
  });
}

for (const reply of [new Error(`${input.password} ${token}`), new Response(`${input.password} ${token}`, { status: 403 }),
  new Response(JSON.stringify({ data: login, errors: [{ message: `${input.password} ${token}` }] })),
  {}, { generateCustomerTokenV2: null }, { generateCustomerTokenV2: { token: '' } },
  { generateCustomerTokenV2: { token: 'bad\r\nheader' } }, { generateCustomerTokenV2: { token: 'bad token' } },
  { generateCustomerTokenV2: { token: 'x'.repeat(8193) } }]) {
  test('login rejection sanitized; no retry or write', async () => {
    const calls = await rejected('LOGIN_REJECTED', { replies: [config, reply] });
    assert.equal(calls.length, 2);
  });
}

for (const reply of [{}, { customer: { __typename: 'Guest' }, storeConfig: proof.storeConfig },
  { customer: proof.customer, storeConfig: { store_code: 'b2c_10010_vi' } },
  new Response(JSON.stringify({ errors: [{ message: token }] })), new Response('bad', { status: 500 })]) {
  test('proof failure or store mismatch preserves old auth', async () => {
    const calls = await rejected('PROOF_FAILED', { replies: [config, login, reply] });
    assert.equal(calls.length, 3);
  });
}

for (const reply of [new Response('not JSON'), new Response(JSON.stringify({ data: config, errors: 'unknown' })),
  new Response(JSON.stringify({ errors: [{ message: input.password }] })), new Response('redirect', { status: 302 }),
  new Response('x'.repeat(16385)), new Response('{}', { headers: { 'content-length': '16385' } }),
  new Response('{}', { headers: { 'content-length': 'bad' } }), new Response(new Uint8Array([0xff]))]) {
  test('config HTTP/GraphQL, encoding and response bounds fail closed', async () => {
    const calls = await rejected('CONFIG_UNVERIFIED', { replies: [reply] });
    assert.equal(calls.length, 1);
  });
}

test('slow response body times out and aborts without login', async () => {
  let signal;
  await assert.rejects(setup(text, { env: { MM_AUTH_FILE: path.join(root, 'unused') }, fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start() {} }));
  } }), { message: 'CONFIG_UNVERIFIED' });
  assert.equal(signal.aborted, true);
});

test('stdin bounds and invalid UTF-8 rejected', async () => {
  assert.equal(await readInput(Readable.from([text.slice(0, 8), text.slice(8)])), text);
  await assert.rejects(readInput(Readable.from([Buffer.alloc(16385)])), { message: 'INVALID_INPUT' });
  await assert.rejects(readInput(Readable.from([Buffer.from([0xff])])), { message: 'INVALID_INPUT' });
});

test('unresponsive fetch and stdin have independent deadlines', async () => {
  let calls = 0;
  await Promise.all([
    assert.rejects(setup(text, { env: { MM_AUTH_FILE: path.join(root, 'unused') }, fetchImpl: () => {
      calls++;
      return new Promise(() => {});
    } }), { message: 'CONFIG_UNVERIFIED' }),
    assert.rejects(readInput(new Readable({ read() {} })), { message: 'INVALID_INPUT' }),
  ]);
  assert.equal(calls, 1);
});

test('stream limit cancels response before reading unbounded body', async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(10000)); },
    cancel() { cancelled = true; },
  });
  await rejected('CONFIG_UNVERIFIED', { replies: [new Response(body)] });
  assert.equal(cancelled, true);
  assert.ok(chunks <= 3);
});

test('CLI output never exposes input, token, remote error or path', async () => {
  const target = await fixture();
  for (const replies of [[config, login, proof], [config, new Error(`${input.email} ${input.password} ${token} ${target.file}`)]]) {
    let stdout = '';
    let stderr = '';
    const status = await main({ args: [], input: Readable.from([text]), ...target, ...fakeFetch(replies),
      output: new Writable({ write(chunk, encoding, done) { stdout += chunk; done(); } }),
      errorOutput: new Writable({ write(chunk, encoding, done) { stderr += chunk; done(); } }),
    });
    assert.equal(stdout, status === 0 ? 'AUTH_SAVED\n' : '');
    assert.equal(stderr, status === 0 ? '' : 'LOGIN_REJECTED\n');
    for (const secret of [input.email, input.password, token, target.file]) assert.ok(!(stdout + stderr).includes(secret));
  }
});

test('argv rejected before stdin/network access', async () => {
  let output = '';
  const status = await main({ args: ['fake-credential-argument'], input: null,
    fetchImpl: () => assert.fail('must not request'),
    errorOutput: { write(value) { output += value; } },
  });
  assert.equal(status, 1);
  assert.equal(output, 'INVALID_INPUT\n');
});

for (const unsafe of ['parent-mode', 'file-mode', 'file-type', 'target-symlink', 'parent-symlink', 'ancestor-symlink', 'parent-owner', 'file-owner']) {
  test(`unsafe storage rejected: ${unsafe}`, async () => {
    const target = await fixture(true);
    let file = target.file;
    let fileOps = fs;
    if (unsafe === 'parent-mode') await fs.chmod(target.directory, 0o755);
    if (unsafe === 'file-mode') await fs.chmod(file, 0o644);
    if (unsafe === 'file-type') { await fs.unlink(file); await fs.mkdir(file); }
    if (unsafe === 'target-symlink') {
      await fs.rename(file, `${file}.old`);
      await fs.symlink(`${file}.old`, file);
    }
    if (unsafe === 'parent-symlink' || unsafe === 'ancestor-symlink') {
      const link = path.join(root, `link-${sequence}`);
      await fs.symlink(target.directory, link);
      file = path.join(link, unsafe === 'ancestor-symlink' ? 'nested/auth.json' : 'auth.json');
    }
    if (unsafe.endsWith('-owner')) {
      const changed = unsafe === 'parent-owner' ? target.directory : file;
      fileOps = { ...fs, lstat: async entry => {
        const stat = await fs.lstat(entry);
        if (entry === changed) stat.uid = process.getuid() + 1;
        return stat;
      } };
    }
    await assert.rejects(setup(text, { env: { MM_AUTH_FILE: file }, ...fakeFetch(), fileOps }), { message: 'STORAGE_UNSAFE' });
    if (unsafe !== 'file-type') assert.equal(await fs.readFile(target.file, 'utf8'), oldAuth);
  });
}

for (const operation of ['open', 'writeFile', 'sync', 'rename']) {
  test(`storage ${operation} failure preserves old credential and cleans temporary`, async () => {
    const failure = () => { throw new Error(`${input.password} ${token}`); };
    const fileOps = operation === 'open' || operation === 'rename' ? { ...fs, [operation]: failure } : {
      ...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        return { chmod: handle.chmod.bind(handle), writeFile: handle.writeFile.bind(handle),
          sync: handle.sync.bind(handle), close: handle.close.bind(handle), [operation]: failure };
      },
    };
    await rejected('STORAGE_FAILED', { fileOps });
    await rejected('STORAGE_FAILED', { fileOps, existing: false });
  });
}

test('target swapped before rename rejected without overwriting replacement', async () => {
  const target = await fixture(true);
  const replacement = path.join(target.directory, 'replacement');
  await fs.writeFile(replacement, 'concurrent-fake-auth', { mode: 0o600 });
  const fileOps = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    await fs.rename(replacement, target.file);
    return handle;
  } };
  await assert.rejects(setup(text, { ...target, ...fakeFetch(), fileOps }), { message: 'STORAGE_UNSAFE' });
  assert.equal(await fs.readFile(target.file, 'utf8'), 'concurrent-fake-auth');
  assert.deepEqual(await fs.readdir(target.directory), ['auth.json']);
});

test('exclusive temporary creation refuses symlink without changing old auth', async () => {
  const target = await fixture(true);
  const fileOps = { ...fs, open: async (...args) => {
    await fs.symlink(target.file, args[0]);
    return fs.open(...args);
  } };
  await assert.rejects(setup(text, { ...target, ...fakeFetch(), fileOps }), { message: 'STORAGE_FAILED' });
  assert.equal(await fs.readFile(target.file, 'utf8'), oldAuth);
  assert.deepEqual(await fs.readdir(target.directory), ['auth.json']);
});

let passed = 0;
try {
  for (const { name, run } of tests) {
    try { await run(); passed++; }
    catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log(`${passed}/${tests.length} auth setup checks passed (fake-only)`);
