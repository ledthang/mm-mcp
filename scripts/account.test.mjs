#!/usr/bin/env node
// mm-mcp account tests: injected fetch + temp permission-controlled auth fixtures,
// node:assert only, serial. The token here is FAKE ("eyFAKE...") — the real credential
// lives in the operator's auth file and is never read by this suite.
// Covers: missing/symlink/wrong mode/perms-parent/owner-ish/over-cap/bad-content =>
// REQUIRES_LOGIN with zero network; exact request bytes; live-per-call (no stale
// success); proofs; store mismatch; projection + paging translation; HTTP/auth-category/
// transport caps; injected-error redaction (raw throw => INTERNAL only); secret
// redaction; ONE live public anonymous replay that checks the real GraphQL PARSE
// response (anonymous, so no credential is involved; offline => explicit SKIP).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccount, ACCOUNT_QUERY, TOOLS } from "../src/account.mjs";

const FAKE_AUTH = "Bearer eyFAKEtoken-not-real-9x";
const STORE = "b2c_70010_vi";
const BASE = mkdtempSync(path.join(os.tmpdir(), "mmacct-"));
process.on("exit", () => rmSync(BASE, { recursive: true, force: true }));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// One scenario env: fresh private tree under BASE with explicit modes.
// mode/fileMode must deny group/other (0700/0600) for the happy path.
function credEnv({ fileMode = 0o600, dirMode = 0o700, symlinkFile = false, parentSymlink = false, content = JSON.stringify({ authorization: FAKE_AUTH, store: STORE }) } = {}) {
  const root = mkdtempSync(path.join(BASE, "cred-")); // mkdtemp => 0700, private
  const realDir = path.join(root, "real");
  const file = path.join(root, "mm-mcp", "auth.json");
  if (parentSymlink) {
    mkdirSync(realDir);
    chmodSync(realDir, 0o700);
    writeFileSync(path.join(realDir, "auth.json"), content);
    chmodSync(path.join(realDir, "auth.json"), fileMode);
    symlinkSync("real", path.join(root, "mm-mcp")); // auth dir path is a symlink
  } else {
    mkdirSync(path.join(root, "mm-mcp"));
    chmodSync(path.join(root, "mm-mcp"), dirMode);
    if (symlinkFile) {
      writeFileSync(path.join(root, "mm-mcp", "real.json"), content);
      chmodSync(path.join(root, "mm-mcp", "real.json"), fileMode);
      symlinkSync("real.json", file);
    } else {
      writeFileSync(file, content);
      chmodSync(file, fileMode);
    }
  }
  return { XDG_DATA_HOME: root, MM_AUTH_FILE: file };
}

// One fixture entry = one HTTP response to hand out (fresh per call, body never re-read).
// spec: <payload object> (json, HTTP 200) | { status, <payload> } | { chunks: [Buffer],
// contentLength? } (streamed; highWaterMark 0 so pull == a real read) | { throwRaw: any }
// (fetch throws a NON-Error value) | Error instance (fetch throws it).
function mk(specs, env = credEnv()) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const spec = specs[Math.min(n, specs.length - 1)];
    const rec = { url: String(url), init, pulls: 0, cancelled: false };
    calls.push(rec);
    n += 1;
    if (spec instanceof Error) throw spec;
    if (isObj(spec) && "throwRaw" in spec) throw spec.throwRaw;
    if (isObj(spec) && "raw" in spec) return spec.raw; // pre-built fake response object
    const status = spec.status ?? 200;
    if (spec.chunks) {
      let i = 0;
      const headers = spec.contentLength ? { "content-length": String(spec.contentLength) } : {};
      const stream = new ReadableStream({
        pull(c) {
          rec.pulls += 1;
          if (i < spec.chunks.length) c.enqueue(spec.chunks[i++]);
          else c.close();
        },
        cancel() { rec.cancelled = true; },
      }, { highWaterMark: 0 });
      return new Response(stream, { status, headers });
    }
    return new Response(JSON.stringify(spec.json ?? spec), { status });
  };
  const acct = createAccount({ fetchImpl, env });
  return { acct, calls, run: (name, args = {}) => acct.callTool(name, args) };
}

const text = (env) => env.content[0].text;
const payload = (env) => JSON.parse(text(env));
const MB = 1024 * 1024;
const ADDR1 = { id: "a1", default_shipping: true, city: "Đà Lạt", street: "1 Xuân Hương", custom_attributes: [{ attribute_code: "address_extra", value: "gần hồ" }] };
const ADDR2 = { id: "a2", default_shipping: false, city: "HCMC", street: "9 Lê Lợi", custom_attributes: [] };
const proof = (addresses, total = addresses.length, pages = 1, storeCode = STORE, storeName = "MM Mega Market") => ({
  data: { customer: { __typename: "Customer", addressesV2: { total_count: total, total_pages: pages, addresses } }, storeConfig: { store_code: storeCode, store_name: storeName } },
});

async function main() {
  await t("missing auth dir: REQUIRES_LOGIN actionable, zero network", async () => {
    const { run, calls } = mk([], { XDG_DATA_HOME: path.join(BASE, "nope") });
    const out = await run("mm_auth_status");
    assert.equal(out.isError, true);
    assert.match(text(out), /^REQUIRES_LOGIN: auth dir missing: /);
    assert.ok(text(out).includes("mm-mcp"), "actionable path shown");
    assert.equal(calls.length, 0);
  });

  await t("default path honored: $XDG_DATA_HOME/mm-mcp/auth.json (MM_AUTH_FILE unset)", async () => {
    const env0 = credEnv();
    const { run, calls } = mk([proof([ADDR1])], { XDG_DATA_HOME: env0.XDG_DATA_HOME });
    const p = payload(await run("mm_auth_status"));
    assert.equal(p.authenticated, true);
    assert.equal(calls.length, 1);
  });

  await t("auth dir is a symlink: refused (lstat, never followed), zero network", async () => {
    const env0 = credEnv({ parentSymlink: true });
    // env points at <root>/mm-mcp/auth.json where mm-mcp is a symlink to real/
    const { run, calls } = mk([proof([ADDR1])], { XDG_DATA_HOME: env0.XDG_DATA_HOME, MM_AUTH_FILE: env0.MM_AUTH_FILE });
    const out = await run("mm_auth_status");
    assert.equal(out.isError, true);
    assert.match(text(out), /^REQUIRES_LOGIN: auth dir is a symlink, refusing: /);
    assert.equal(calls.length, 0);
  });

  await t("auth file is a symlink: refused, zero network", async () => {
    const { run, calls } = mk([proof([ADDR1])], credEnv({ symlinkFile: true }));
    const out = await run("mm_auth_status");
    assert.match(text(out), /^REQUIRES_LOGIN: auth file is a symlink, refusing: /);
    assert.equal(calls.length, 0);
  });

  await t("wrong file mode (640/644/700/400): REQUIRES_LOGIN, only 600 passes", async () => {
    for (const mode of [0o640, 0o644, 0o700, 0o400]) {
      const { run, calls } = mk([proof([ADDR1])], credEnv({ fileMode: mode }));
      const out = await run("mm_list_addresses");
      assert.match(text(out), /^REQUIRES_LOGIN: auth file must be mode 600$/, "reject mode " + mode.toString(8));
      assert.equal(calls.length, 0);
    }
  });

  await t("parent dir group-readable (755): REQUIRES_LOGIN, zero network", async () => {
    const { run, calls } = mk([proof([ADDR1])], credEnv({ dirMode: 0o755 }));
    const out = await run("mm_auth_status");
    assert.match(text(out), /^REQUIRES_LOGIN: auth dir allows group\/other access: /);
    assert.equal(calls.length, 0);
  });

  await t("auth file over 16 KiB: REQUIRES_LOGIN, unbounded read never happens", async () => {
    const { run, calls } = mk([proof([ADDR1])], credEnv({ content: JSON.stringify({ authorization: FAKE_AUTH, store: STORE }) + " ".repeat(20000) }));
    const out = await run("mm_list_addresses", { page_index: 3 });
    assert.match(text(out), /^REQUIRES_LOGIN: auth file is over 16 KiB$/);
    assert.equal(calls.length, 0);
  });

  await t("bad auth file content: REQUIRES_LOGIN (empty/not-JSON/wrong-keys/not-Bearer/bad store)", async () => {
    for (const content of ["", "{", "[1,2]", "{}", '{"authorization":"Bearer x"}', '{"authorization":"Basic xyz","store":"b2c_70010_vi"}',
      '{"authorization":"Bearer two words","store":"b2c_70010_vi"}', '{"authorization":"Bearer x","store":"b2c_vi"}',
      '{"authorization":"Bearer x","store":"b2c_70010_vi","extra":1}', '{"authorization":"","store":"b2c_70010_vi"}']) {
      const { run, calls } = mk([proof([ADDR1])], credEnv({ content }));
      const out = await run("mm_auth_status");
      assert.equal(out.isError, true, "must reject " + JSON.stringify(content).slice(0, 60));
      assert.match(text(out), /^REQUIRES_LOGIN: /);
      assert.ok(!text(out).includes("eyFAKE"), "token not echoed");
      assert.equal(calls.length, 0);
    }
  });

  await t("exact request bytes: fixed origin, verbatim query, JSON vars, Authorization+store headers only", async () => {
    const { run, calls } = mk([proof([ADDR1, ADDR2], 5, 2)]);
    const out = await run("mm_list_addresses", { page_index: 5, page_size: 3 });
    assert.equal(out.isError, undefined, "success: " + text(out));
    assert.equal(calls.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(u.origin, "https://online.mmvietnam.com");
    assert.equal(u.pathname, "/graphql");
    assert.equal(u.searchParams.get("query"), ACCOUNT_QUERY, "query string verbatim");
    assert.deepEqual(JSON.parse(u.searchParams.get("variables")), { currentPage: 6, pageSize: 3 }, "currentPage = page_index + 1, via JSON vars only");
    assert.deepEqual(calls[0].init.headers, { Authorization: FAKE_AUTH, store: STORE }, "exact credential headers (fixture fake)");
    assert.ok(!Object.keys(calls[0].init.headers).some((h) => /cookie/i.test(h)), "no cookies");
    assert.equal(calls[0].init.signal.constructor.name, "AbortSignal");
    assert.ok(!("method" in calls[0].init) || calls[0].init.method === "GET", "GET");
    // structural self-check of the query text: braces balanced and storeConfig sits at
    // TOP level (the shipped regression was one } short, nesting it inside customer)
    let depth = 0;
    let siblingOk = false;
    for (let i = 0; i < ACCOUNT_QUERY.length; i += 1) {
      const ch = ACCOUNT_QUERY[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      if (depth < 0) { siblingOk = false; break; }
      if (ACCOUNT_QUERY.startsWith("storeConfig{", i) && depth === 1) siblingOk = true;
    }
    assert.equal(depth, 0, "query is brace-balanced");
    assert.ok(siblingOk, "storeConfig is a top-level sibling of customer, not nested");
  });

  await t("query carries no identity/order fields", () => {
    for (const banned of ["email", "firstname", "lastname", "telephone", "phone", "orders", "wishlist"]) {
      assert.ok(!ACCOUNT_QUERY.toLowerCase().includes(banned), "no " + banned + " in query");
    }
  });

  await t("public parse regression: anonymous live replay answers WITHOUT a Syntax Error", async () => {
    // The one live check in this suite, and it is ANONYMOUS: no Authorization header,
    // no auth file touched. Upstream must PARSE (any AUTHENTICATION/other error shape
    // is fine; a GraphQL Syntax Error means the shipped query text is broken).
    const u = new URL("https://online.mmvietnam.com/graphql");
    u.searchParams.set("query", ACCOUNT_QUERY);
    u.searchParams.set("variables", JSON.stringify({ currentPage: 1, pageSize: 20 }));
    let res;
    try {
      res = await fetch(u.toString(), { headers: { store: STORE }, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      console.error(`SKIP live parse check (${(e && e.name) || "fetch failed"})`);
      return;
    }
    const body = await res.text();
    assert.ok(!/Syntax Error/i.test(body), "upstream PARSE failed: " + body.slice(0, 200));
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    assert.ok(parsed !== null && isObj(parsed), "reply is still JSON even anonymous");
    console.error(`live parse ok: HTTP ${res.status}, errors=${Array.isArray(parsed.errors) ? parsed.errors.length : 0}`);
  });

  await t("mm_auth_status: authenticated true + observed_at only after live proof; live per call", async () => {
    const { run, calls } = mk([proof([ADDR1])]);
    const a = payload(await run("mm_auth_status"));
    assert.deepEqual({ ...a, observed_at: "X" }, { authenticated: true, store_code: STORE, store_name: "MM Mega Market", observed_at: "X" });
    assert.ok(!Number.isNaN(Date.parse(a.observed_at)));
    const b = payload(await run("mm_auth_status"));
    assert.ok(Date.parse(b.observed_at) >= Date.parse(a.observed_at));
    await run("mm_auth_status");
    assert.equal(calls.length, 3, "every call re-proves: no cached success");
  });

  await t("HTTP 200 but customer null: REQUIRES_LOGIN, no fake false-success", async () => {
    const { run } = mk([{ data: { customer: null, storeConfig: { store_code: STORE, store_name: "MM Mega Market" } } }]);
    const out = await run("mm_auth_status");
    assert.equal(out.isError, true);
    assert.match(text(out), /^REQUIRES_LOGIN: HTTP 200 but no customer: not authenticated$/);
  });

  await t("GraphQL authentication category: REQUIRES_LOGIN; other errors: count only, no echo", async () => {
    const out1 = await (mk([{ errors: [{ message: "The customer isn't authorized.", categories: ["AUTHENTICATION"] }] }]).run("mm_auth_status"));
    assert.match(text(out1), /^REQUIRES_LOGIN: 1 authentication error\(s\)$/);
    assert.ok(!text(out1).includes("isn't authorized"), "upstream message never echoed");
    const out2 = await (mk([{ errors: [{ message: "boom secret detail", categories: ["OTHER"] }] }]).run("mm_list_addresses"));
    assert.equal(text(out2), "GRAPHQL_ERRORS: 1 error(s)");
    const out3 = await (mk([{ errors: [{ message: "a", extensions: { code: "UNAUTHENTICATED" } }, { message: "b", categories: ["AUTHENTICATION"] }] }]).run("mm_get_delivery_context"));
    assert.match(text(out3), /^REQUIRES_LOGIN: 2 authentication error\(s\)$/);
  });

  await t("store mismatch in storeConfig: fail closed, no partial context", async () => {
    const { run, calls } = mk([proof([ADDR1], 1, 1, "b2c_99999_vi")]);
    const out = await run("mm_get_delivery_context");
    assert.equal(out.isError, true);
    assert.match(text(out), /^STORE_MISMATCH: storeConfig disagrees with the requested store$/);
    assert.ok(!text(out).includes("b2c_99999_vi"), "mismatched code not echoed back as context");
    assert.equal(calls.length, 1);
  });

  await t("mm_get_delivery_context: store fields from serverConfig + selection NOT verified note", async () => {
    const { run } = mk([proof([ADDR1])]);
    const p = payload(await run("mm_get_delivery_context"));
    assert.equal(p.store_code, STORE);
    assert.equal(p.store_name, "MM Mega Market");
    assert.match(p.address_selection, /^NOT verified: /);
    assert.ok(/default_shipping/.test(p.address_selection) && /not proof/.test(p.address_selection), "explicit no-inference note");
    assert.ok(!Number.isNaN(Date.parse(p.observed_at)));
    assert.ok(!("addresses" in p), "delivery context does not dump address rows");
  });

  await t("mm_list_addresses: saved-field projection + pagination + observed_at", async () => {
    const { run, calls } = mk([proof([ADDR1, ADDR2], 32, 2)]);
    const p = payload(await run("mm_list_addresses", { page_index: 0, page_size: 20 }));
    assert.deepEqual(p.addresses, [ADDR1, ADDR2], "exactly the saved fields, in upstream order");
    assert.deepEqual(p.pagination, { page_index: 0, page_size: 20, total_count: 32, total_pages: 2 });
    assert.deepEqual(p.context, { store_code: STORE, authenticated: true });
    assert.ok(!Number.isNaN(Date.parse(p.observed_at)));
    assert.deepEqual(JSON.parse(new URL(calls[0].url).searchParams.get("variables")), { currentPage: 1, pageSize: 20 });
    // unverified scalar types pass through UNTOUCHED (no coercion, no guessing):
    const odd = { id: 42, default_shipping: false, city: null, street: "", custom_attributes: [{ attribute_code: "x", value: 7 }] };
    const p2 = payload(await (mk([proof([odd], 41, 3)]).run("mm_list_addresses", { page_index: 40, page_size: 1 })));
    assert.deepEqual(p2.addresses, [odd], "numeric id, null city, numeric attribute value: passthrough");
    assert.deepEqual(p2.pagination, { page_index: 40, page_size: 1, total_count: 41, total_pages: 3 }, "boundary page_index 40 -> currentPage 41");
  });

  await t("malformed address rows (structure only, no type guesses): fail closed", async () => {
    const bad = [
      ["not-an-object", /^BAD_UPSTREAM_DATA: address row$/],
      [null, /^BAD_UPSTREAM_DATA: address row$/],
      [{ id: "x1", default_shipping: false, city: "X", custom_attributes: [] }, /^BAD_UPSTREAM_DATA: address row$/], // street key missing
      { id: "x2", default_shipping: false, city: "X", street: "Y", custom_attributes: "nope" },
      { id: "x3", default_shipping: false, city: "X", street: "Y", custom_attributes: [{ attribute_code: "c" }] }, // value missing
      [{ id: "a1", default_shipping: false, city: "X", street: "Y", custom_attributes: [] }, /^BAD_UPSTREAM_DATA: duplicate address id$/],
    ];
    for (const entry of bad) {
      const [a, re] = Array.isArray(entry) && entry.length === 2 && (typeof entry[1] === "object") ? entry : [entry, /^BAD_UPSTREAM_DATA: address row$/];
      const { run } = mk([proof([ADDR1, a])]);
      const out = await run("mm_list_addresses");
      assert.equal(out.isError, true, "must fail closed: " + JSON.stringify(a));
      assert.match(text(out), re, "wrong code for " + JSON.stringify(a));
    }
  });

  await t("strict args: unknown props rejected on every tool, zero network", async () => {
    for (const name of ["mm_auth_status", "mm_get_delivery_context", "mm_list_addresses"]) {
      const { run, calls } = mk([proof([ADDR1])]);
      const out = await run(name, { foo: 1 });
      assert.equal(out.isError, true, name + " must reject unknown prop");
      assert.match(text(out), /^INVALID_ARGS: unknown argument\(s\): foo$/);
      assert.equal(calls.length, 0, "no fetch before/after arg rejection: " + name);
    }
    const bads = [{ page_index: -1 }, { page_index: 41 }, { page_index: 1.5 }, { page_index: "2" }, { page_size: 0 }, { page_size: 21 }, { page_size: "5" }, { page_size: true }, { page_index: 0, other: 2 }];
    for (const a of bads) {
      const { run, calls } = mk([proof([ADDR1])]);
      const out = await run("mm_list_addresses", a);
      assert.match(text(out), /^INVALID_ARGS/, "reject " + JSON.stringify(a));
      assert.equal(calls.length, 0);
    }
  });

  await t("HTTP 401/403: REQUIRES_LOGIN; 500: UPSTREAM_HTTP_STATUS; no body echo", async () => {
    for (const s of [401, 403]) {
      const { run, calls } = mk([{ status: s, json: { message: "detail " + s } }]);
      const out = await run("mm_auth_status");
      assert.equal(out.isError, true);
      assert.match(text(out), new RegExp(`^REQUIRES_LOGIN: HTTP ${s} credential rejected$`));
      assert.ok(!text(out).includes("detail"), "body not echoed");
      assert.equal(calls.length, 1, "no retry");
    }
    const { run, calls } = mk([{ status: 500, chunks: [Buffer.from("boom 500")] }]);
    assert.equal(text(await run("mm_list_addresses")), "UPSTREAM_HTTP_STATUS: HTTP 500");
    assert.equal(calls[0].cancelled, true, "error body released");
  });

  await t("timeout/abort: UPSTREAM_TIMEOUT, single attempt; network failure: UPSTREAM_UNREACHABLE", async () => {
    const to = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { run, calls } = mk([to]);
    assert.equal(text(await run("mm_auth_status")), "UPSTREAM_TIMEOUT");
    assert.equal(calls.length, 1);
    const ab = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    assert.equal(text(await (mk([ab]).run("mm_list_addresses"))), "UPSTREAM_TIMEOUT");
    assert.equal(text(await (mk([new TypeError("fetch failed")]).run("mm_auth_status"))), "UPSTREAM_UNREACHABLE");
  });

  await t("stream over 2 MiB cap: RESPONSE_TOO_LARGE, cancelled, no full allocation", async () => {
    const { run, calls } = mk([{ chunks: [Buffer.alloc(MB, 97), Buffer.alloc(MB, 98), Buffer.alloc(MB, 99)] }]);
    const out = await run("mm_list_addresses");
    assert.equal(text(out), "RESPONSE_TOO_LARGE");
    assert.equal(calls[0].pulls, 3, "stopped at the chunk that crosses 2 MiB");
    assert.equal(calls[0].cancelled, true);
    const declared = mk([{ chunks: [Buffer.alloc(3 * MB)], contentLength: 3 * MB }]);
    assert.equal(text(await declared.run("mm_auth_status")), "RESPONSE_TOO_LARGE");
    assert.equal(declared.calls[0].pulls, 0, "declared over-cap: body never read");
  });

  await t("unparseable body / missing data: RESPONSE_NOT_JSON", async () => {
    assert.equal(text(await (mk([{ json: "<html>gate</html>" }]).run("mm_auth_status"))), "RESPONSE_NOT_JSON");
    assert.equal(text(await (mk([{ json: { data: "nope" } }]).run("mm_list_addresses"))), "RESPONSE_NOT_JSON: no data object");
  });

  await t("injected error redaction: raw thrown messages never reach output", async () => {
    // fetch transport failure with a secret-bearing message => fixed UPSTREAM_* code,
    // raw text never echoed, exactly one attempt.
    const leaky = new Error("upstream said: Bearer eySECRETabc at 7 Lê Lợi, total 999999");
    const { run, calls } = mk([leaky]);
    const out = await run("mm_auth_status");
    assert.equal(out.isError, true);
    assert.equal(text(out), "UPSTREAM_UNREACHABLE");
    assert.ok(!text(out).includes("eySECRETabc") && !text(out).includes("Lê Lợi") && !text(out).includes("999999"));
    assert.equal(calls.length, 1, "no retry storm");
    // fake response object whose header read throws (Error and non-Error), a spot no
    // transport mapping covers: must be exactly INTERNAL, raw message never echoed.
    const thrower = (msg) => ({ ok: true, status: 200, headers: { get() { throw msg; } }, body: null });
    const out2 = await (mk([{ raw: thrower("header read boom Bearer zz9 xyz") }]).run("mm_auth_status"));
    assert.equal(text(out2), "INTERNAL", "exactly INTERNAL: " + text(out2));
    assert.ok(!text(out2).includes("zz9") && !text(out2).includes("boom"));
    const out3 = await (mk([{ raw: thrower("string failure 12345678") }]).run("mm_list_addresses"));
    assert.equal(text(out3), "INTERNAL");
    // session survives: a later call still succeeds
    const sess = mk([{ raw: thrower("nope") }, proof([ADDR1])]);
    assert.equal(text(await sess.run("mm_auth_status")), "INTERNAL");
    assert.equal(payload(await sess.run("mm_auth_status")).authenticated, true, "recovers after internal error");
  });

  await t("secret redaction: FAKE token appears in no tool output (errors or successes)", async () => {
    const { run: ok } = mk([proof([ADDR1, ADDR2])]);
    assert.ok(!text(await ok("mm_auth_status")).includes("eyFAKE"));
    assert.ok(!text(await ok("mm_get_delivery_context")).includes("Bearer"));
    assert.ok(!text(await ok("mm_list_addresses")).includes("eyFAKEtoken"));
    const { run: denied } = mk([{ status: 401, json: {} }]);
    assert.ok(!text(await denied("mm_auth_status")).includes("Bearer"));
    assert.ok(!text(await denied("mm_list_addresses", { page_index: 1 })).includes(FAKE_AUTH));
  });

  console.error(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

let checks = 0;
let failures = 0;
async function t(name, fn) {
  checks += 1;
  try {
    await fn();
    console.error("PASS " + name);
  } catch (e) {
    failures += 1;
    console.error("FAIL " + name + " :: " + (e && e.message));
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
