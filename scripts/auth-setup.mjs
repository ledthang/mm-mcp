import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ENDPOINT = 'https://online.mmvietnam.com/graphql';
export const CONFIG_QUERY = 'query AuthSetupConfig{recaptchaV3Config{website_key forms}}';
export const LOGIN_QUERY = 'mutation SignIn($email:String!,$password:String!){generateCustomerTokenV2(email:$email,password:$password){token}}';
export const PROOF_QUERY = 'query AuthSetupProof{customer{__typename} storeConfig{store_code}}';
const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 10_000;
const fail = code => { throw new Error(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const controls = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export async function readInput(stream) {
  const timeout = setTimeout(() => stream.destroy(new Error('INVALID_INPUT')), TIMEOUT_MS);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES) fail('INVALID_INPUT');
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail('INVALID_INPUT');
  } finally {
    clearTimeout(timeout);
  }
}

function parseInput(text) {
  let input;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('INVALID_INPUT');
    input = JSON.parse(text);
  } catch { fail('INVALID_INPUT'); }
  if (!record(input) || Object.keys(input).sort().join(',') !== 'email,password,store') fail('INVALID_INPUT');
  const { email, password, store } = input;
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || controls.test(email)
    || typeof password !== 'string' || !password.trim() || password.length > 4096 || controls.test(password)
    || typeof store !== 'string' || !/^b2c_\d{1,8}_vi$/.test(store)) fail('INVALID_INPUT');
  return input;
}

async function request(fetchImpl, store, query, variables, authorization, code) {
  const controller = new AbortController();
  let timer;
  let reader;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(code));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Store: store, ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok || !response.body) fail(code);
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail(code);
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) fail(code);
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!record(result) || !record(result.data)
        || (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length))) fail(code);
      return result.data;
    })()]);
  } catch { fail(code); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

export function authPath(env = process.env, home = homedir()) {
  const selected = env.MM_AUTH_FILE ?? path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'mm-mcp', 'auth.json');
  if (typeof selected !== 'string' || !selected || controls.test(selected)) fail('STORAGE_UNSAFE');
  return path.resolve(selected);
}

async function inspectTarget(file, fileOps) {
  try {
    const stat = await fileOps.lstat(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) fail('STORAGE_UNSAFE');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectParents(file, fileOps, create) {
  const parent = path.dirname(file);
  const ancestors = [path.parse(parent).root];
  for (const part of parent.slice(path.parse(parent).root.length).split(path.sep).filter(Boolean)) {
    ancestors.push(path.join(ancestors.at(-1), part));
  }
  const identities = [];
  for (const directory of ancestors) {
    if (create) {
      try { await fileOps.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await fileOps.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORAGE_UNSAFE');
    if (directory === parent && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700)) fail('STORAGE_UNSAFE');
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  return identities.join(',');
}

async function storeAuth(file, auth, fileOps) {
  let temporary;
  let handle;
  try {
    const identities = await inspectParents(file, fileOps, true);
    const previous = await inspectTarget(file, fileOps);
    temporary = path.join(path.dirname(file), `.auth-setup-${randomUUID()}.tmp`);
    handle = await fileOps.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(auth)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (identities !== await inspectParents(file, fileOps, false)) fail('STORAGE_UNSAFE');
    const current = await inspectTarget(file, fileOps);
    if (previous?.ino !== current?.ino || previous?.dev !== current?.dev) fail('STORAGE_UNSAFE');
    await fileOps.rename(temporary, file);
    temporary = null;
  } catch (error) {
    fail(error.message === 'STORAGE_UNSAFE' ? 'STORAGE_UNSAFE' : 'STORAGE_FAILED');
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await fileOps.unlink(temporary).catch(() => {});
  }
}

export async function setup(text, { fetchImpl = globalThis.fetch, env = process.env, home = homedir(), fileOps = fs } = {}) {
  const { email, password, store } = parseInput(text);
  const file = authPath(env, home);
  const config = (await request(fetchImpl, store, CONFIG_QUERY, {}, null, 'CONFIG_UNVERIFIED')).recaptchaV3Config;
  if (!record(config) || typeof config.website_key !== 'string' || config.website_key.length > 4096
    || controls.test(config.website_key) || !Array.isArray(config.forms)
    || config.forms.length > 100 || config.forms.some(form => typeof form !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(form))) fail('CONFIG_UNVERIFIED');
  if (config.forms.includes('CUSTOMER_LOGIN')) fail('CHALLENGE_REQUIRED');
  const login = await request(fetchImpl, store, LOGIN_QUERY, { email, password }, null, 'LOGIN_REJECTED');
  const token = login.generateCustomerTokenV2?.token;
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token) || token.length > 8192) fail('LOGIN_REJECTED');
  const authorization = `Bearer ${token}`;
  const proof = await request(fetchImpl, store, PROOF_QUERY, {}, authorization, 'PROOF_FAILED');
  if (proof.customer?.__typename !== 'Customer' || proof.storeConfig?.store_code !== store) fail('PROOF_FAILED');
  await storeAuth(file, { authorization, store }, fileOps);
}

export async function main({ args = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr, ...options } = {}) {
  try {
    if (args.length) fail('INVALID_INPUT');
    await setup(await readInput(input), options);
    output.write('AUTH_SAVED\n');
    return 0;
  } catch (error) {
    const code = ['INVALID_INPUT', 'CONFIG_UNVERIFIED', 'CHALLENGE_REQUIRED', 'LOGIN_REJECTED', 'PROOF_FAILED', 'STORAGE_UNSAFE', 'STORAGE_FAILED'].includes(error.message) ? error.message : 'SETUP_FAILED';
    errorOutput.write(`${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
