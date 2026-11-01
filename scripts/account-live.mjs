#!/usr/bin/env node
// Live gate: the REAL MCP server on stdio, real endpoint, two children, one at a time.
//
//   S1 absent-auth: a SEPARATE child whose MM_AUTH_FILE is a nonexistent path (never
//      created). No credential exists for it; every authenticated call answers
//      REQUIRES_LOGIN locally before any request, so S1 needs no live credential and
//      runs fast.
//   S2 account-live: a child with the INHERITED environment (no rewriting) — real
//      credential via the operator's auth file, read by the CHILD's account module per
//      call only (the secret stays inside the child; this gate never opens auth.json).
//      Initialize properly, then one live call per tool: tools/list ->
//      mm_search_products -> mm_get_product (guest) -> mm_auth_status ->
//      mm_get_delivery_context -> mm_list_addresses -> mm_get_cart -> mm_cart_summary.
//
// Lifetime bounds, one child at a time:
//   - one request -> at most one reply; CALL_TIMEOUT (30 s) covers a hung answer
//     (the server itself caps one upstream call at 25 s);
//   - retained stdout is capped at MAX_LINE_BYTES (2 MiB per pending line) — over the
//     cap the session answers LOCAL_LIMIT and the child is SIGKILLed (documented:
//     any legitimate envelope here is far below 2 MiB);
//   - child 'close'/'error' or a stdin EPIPE resolve the outstanding waiter
//     immediately (never wait out CALL_TIMEOUT for a dead child / broken pipe);
//   - close(): resolves only on the child's real 'close' (a broken stdin is NOT a
//     closed process): stdin end, CLOSE_GRACE (5 s), then SIGKILL the lingering
//     child; an already-closed child resolves immediately and the grace timer is
//     cleared (no stale timer killing a reused PID). A process 'exit' hook
//     SIGKILLs any surviving child.
//
// Tests MUTABLE invariants, never fixed values: no asserted address count, no asserted
// cart size, no exact equality between mm_get_cart and mm_cart_summary (concurrent
// edits allowed — each is validated on its own). authenticated:true must come from an
// actual upstream proof (strict envelope, live call, consistent store, plausible
// observed_at) — never assumed. observed_at must sit inside [child spawn, now].
//
// stdout: "PASS <id> <safe facts>" / "FAIL <id> <fixed why>" + one summary line. Safe
// facts = booleans / counts / store code only — never addresses, items, the token,
// stderr content or raw replies. Unsolicited/duplicate frames and blank-line noise are
// counted (orphan_frames), never silently dropped.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");
const PV = "2024-11-05";
const CALL_TIMEOUT = 30000; // one request -> one envelope; server caps one upstream call at 25 s
const MAX_LINE_BYTES = 2 * 1024 * 1024; // retained stdout cap per pending line (2 MiB, documented)
const CLOSE_GRACE = 5000;
const URL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const GUEST_TOOLS = ["mm_search_products", "mm_get_product"];
const AUTH_TOOLS = ["mm_auth_status", "mm_get_delivery_context", "mm_list_addresses", "mm_get_cart", "mm_cart_summary"];

const children = [];
function hardKill(c) {
  if (c.exitCode === null && c.signalCode === null) { try { c.kill("SIGKILL"); } catch { /* kill threw: not proof the child is gone — only 'close' confirms termination */ } }
}
function clean() { for (const c of children) hardKill(c); }
process.on("exit", clean);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const moneyOk = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const qtyOk = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
// observed_at must sit inside [child spawn, now] (+ small clock slack): never stale, never future
const isoOk = (st, s) => {
  const t = Date.parse(s);
  return !Number.isNaN(t) && t >= st.spawnedAt && t <= Date.now() + 5000;
};
const vndRow = (r) => moneyOk(r.price_vnd) && moneyOk(r.regular_price_vnd) && r.price_vnd <= r.regular_price_vnd;
const cartLineOk = (l) =>
  typeof l.uid === "string" && l.uid !== "" && typeof l.sku === "string" && l.sku !== "" &&
  typeof l.name === "string" && l.name !== "" && qtyOk(l.quantity) && moneyOk(l.price_vnd) && moneyOk(l.row_total_vnd);
const shipOk = (s) =>
  isObj(s) && Number.isSafeInteger(s.address_count) && s.address_count >= 0 && Array.isArray(s.selected_methods) &&
  s.selected_methods.every((m) => isObj(m) && typeof m.method_title === "string" && m.method_title !== "" && moneyOk(m.amount_vnd));
const totalsOk = (p) =>
  p.currency === "VND" && moneyOk(p.subtotal_excluding_tax_vnd) && moneyOk(p.grand_total_vnd);

let checks = 0;
let passed = 0;
function check(id, facts) { // facts(): throws => FAIL line; returns safe object => PASS line
  checks += 1;
  try {
    const f = facts();
    passed += 1;
    console.log(`PASS ${id} ${JSON.stringify(f ?? {})}`);
  } catch (e) {
    console.log(`FAIL ${id} ${e && (e.code || e.name) || "ERR"}`);
  }
}

// One child session on stdio. cmd is fixed by the caller (no env override of the
// executable). ask() = one strict JSON-RPC request, reply matched by exact id;
// notify() owes no reply. Frames reaching a session with no live waiter are counted
// as orphans (visible in facts, never silent). All timing waits are bounded above.
function spawnGate(env, cmd) {
  const st = { spawnedAt: Date.now(), dead: null, stderrClean: true, cur: null, orphans: 0, closed: null, childClosed: false, exitCode: null, exitSignal: null };
  const c = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], env });
  children.push(c);
  const wake = (frame) => {
    const w = st.cur;
    if (!w) return false;
    st.cur = null;
    clearTimeout(w.timer);
    w.resolve(frame);
    return true;
  };
  // dead child / broken stdin => resolve the outstanding waiter right away with a
  // fixed reason (never wait out the clock, never an unhandled stream 'error')
  const bury = (why) => { if (!st.dead) { st.dead = why; wake({ dead: why }); } };
  c.on("error", () => bury("CHILD_ERROR"));
  // real termination tracked apart from pipe breakage: a stdin EPIPE does NOT mean
  // the process is gone — childClosed/exitCode/exitSignal come only from 'close'
  c.on("close", (code, signal) => { st.childClosed = true; st.exitCode = code; st.exitSignal = signal; bury("CHILD_CLOSED"); });
  c.stdin.on("error", () => bury("STDIN_ERROR")); // permanent, installed before any write
  c.stderr.on("data", () => { st.stderrClean = false; }); // counted, content never kept

  let buf = Buffer.alloc(0);
  let capped = false;
  c.stdout.on("data", (d) => {
    if (capped) return; // stream stays drained after the cap fired
    if (buf.length + d.length > MAX_LINE_BYTES) {
      capped = true;
      if (!wake({ localLimit: true })) st.orphans += 1; // over-cap with no live waiter: counted
      hardKill(c);
      return;
    }
    buf = Buffer.concat([buf, d]);
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      if (!line.trim()) continue;
      let f;
      try { f = JSON.parse(line); } catch { f = { badLine: true }; }
      if (!isObj(f)) f = { badLine: true }; // parsed non-object: rejected before any 'in'/prop op
      if (!wake(f)) st.orphans += 1; // unsolicited/duplicate frame: counted, not silent
    }
  });

  st.ask = (id, method, params) => {
    if (st.dead) return Promise.resolve({ dead: st.dead });
    return new Promise((resolve) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => { if (st.cur === w) { st.cur = null; resolve({ timeout: true }); } }, CALL_TIMEOUT);
      st.cur = w;
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  };
  st.notify = (method) => { if (!st.dead) c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); };
  st.strict = (fr, id) => {
    if (fr.dead) return { ok: false, why: "child closed before answer" };
    if (fr.timeout) return { ok: false, why: "answer timeout" };
    if (fr.localLimit) return { ok: false, why: "stdout over 2 MiB cap" };
    if (fr.badLine) return { ok: false, why: "unparseable frame" };
    if (fr.jsonrpc !== "2.0") return { ok: false, why: "jsonrpc" };
    if (fr.id !== id) return { ok: false, why: "id mismatch" };
    if (("result" in fr) === ("error" in fr)) return { ok: false, why: "not exactly one of result|error" };
    if ("error" in fr && !(isObj(fr.error) && Number.isInteger(fr.error.code) && typeof fr.error.message === "string")) return { ok: false, why: "error shape" };
    return { ok: true, fr };
  };
  // tools/call: strict envelope + exactly one non-empty text block.
  st.call = (id, name, args) =>
    st.ask(id, "tools/call", { name, arguments: args }).then((fr) => {
      const s = st.strict(fr, id);
      if (!s.ok) return s;
      const res = s.fr.result;
      if (!isObj(res) || !Array.isArray(res.content) || res.content.length !== 1) return { ok: false, why: "content" };
      const blk = res.content[0];
      if (!isObj(blk) || blk.type !== "text" || typeof blk.text !== "string" || blk.text.length === 0) return { ok: false, why: "content" };
      return { ok: true, text: blk.text, isError: res.isError === true };
    });
  // close bounded: resolve ONLY on the child's real 'close' — a STDIN_ERROR marks the
  // pipe broken, not the process gone, so the session still waits (bounded) and kills.
  // An already-closed child resolves immediately; the grace timer is cleared when close
  // fires so no stale timer can SIGKILL a reused PID after the session ended.
  st.close = () => {
    if (st.closed) return st.closed;
    st.closed = new Promise((res) => {
      let timer = null;
      let done = false;
      const fin = (code, signal) => { if (!done) { done = true; if (timer) clearTimeout(timer); res({ code, signal }); } };
      if (st.childClosed) { fin(st.exitCode, st.exitSignal); return; } // gone already: no wait, no timer
      c.once("close", fin);
      c.stdin.end(); // pipe with no reader from here: EPIPE is handled, never unhandled
      timer = setTimeout(() => hardKill(c), CLOSE_GRACE); // lingering child: SIGKILL after grace
    });
    return st.closed;
  };
  return st;
}

async function main() {
  // ------------------------------------------ S1: absent auth (separate child, nonexistent path)
  {
    const st = spawnGate({ ...process.env, MM_AUTH_FILE: path.join(os.tmpdir(), `mmlive-absent-${process.pid}`, "auth.json") }, [process.execPath, SERVER]);
    const a0 = st.strict(await st.ask(0, "initialize", { protocolVersion: PV, clientInfo: { name: "live-gate", version: "1" }, capabilities: {} }), 0);
    check("S1.init_ok", () => {
      assert.ok(a0.ok, a0.why);
      assert.equal(a0.fr.result.protocolVersion, PV);
      assert.equal(a0.fr.result.serverInfo.name, "mm-mcp");
      return { init: true };
    });
    st.notify("notifications/initialized"); // owes NO reply
    const a1 = st.strict(await st.ask(2, "ping"), 2);
    check("S1.ping_after_notification", () => {
      assert.ok(a1.ok, a1.why); // id 2 answered => ping ok; suppression proven only by final orphan==0
      assert.deepEqual(a1.fr.result, {});
      return { ping: true };
    });
    for (const [i, t] of AUTH_TOOLS.entries()) {
      const id = 3 + i;
      const r = await st.call(id, t, t === "mm_list_addresses" ? { page_index: 0, page_size: 5 } : {});
      check(`S1.${t}_requires_login`, () => {
        assert.ok(r.ok, r.why);
        assert.ok(r.isError, "absent credential must fail");
        assert.match(r.text, /^REQUIRES_LOGIN\b/, "one fixed code");
        assert.ok(!/Bearer\s+\S{8,}/.test(r.text) && !/ey[A-Za-z0-9._~+/=-]{10,}/.test(r.text), "no token-shaped secret echoed");
        return { requires_login: true };
      });
    }
    const cl = await st.close();
    check("S1.clean_exit", () => {
      assert.equal(cl.code, 0, "clean exit after stdin close");
      assert.ok(st.stderrClean, "no stderr noise from the server");
      assert.equal(st.orphans, 0, "no unsolicited/duplicate frames");
      return { exit: true, stderr_clean: true };
    });
  }

  // ----------------------------------------- S2: account-live (inherited env, real credential)
  {
    const st = spawnGate({ ...process.env }, [process.execPath, SERVER]); // INHERITED env — no rewriting
    const a0 = st.strict(await st.ask(0, "initialize", { protocolVersion: PV, clientInfo: { name: "live-gate", version: "1" }, capabilities: {} }), 0);
    check("S2.init_ok", () => {
      assert.ok(a0.ok, a0.why);
      assert.equal(a0.fr.result.protocolVersion, PV);
      return { init: true };
    });
    st.notify("notifications/initialized");
    const a1 = st.strict(await st.ask(2, "ping"), 2);
    check("S2.ping_after_notification", () => {
      assert.ok(a1.ok, a1.why); // id 2 answered => ping ok; suppression proven only by final orphan==0
      assert.deepEqual(a1.fr.result, {});
      return { ping: true };
    });
    const a3 = st.strict(await st.ask(3, "tools/list"), 3);
    check("S2.tools_list", () => {
      assert.ok(a3.ok, a3.why);
      const tools = a3.fr.result?.tools;
      assert.ok(Array.isArray(tools), "tools array");
      assert.equal(tools.length, 7, "seven tools: 2 guest + 5 authenticated");
      const names = tools.map((t) => t.name);
      assert.ok(GUEST_TOOLS.every((t) => names.includes(t)) && AUTH_TOOLS.every((t) => names.includes(t)), "exact tool set");
      assert.ok(tools.every((t) => typeof t.description === "string" && t.description.length > 0 && isObj(t.inputSchema) && t.inputSchema.type === "object" && t.inputSchema.additionalProperties === false), "every tool described, strict object schema");
      return { count: tools.length };
    });

    let searchPage = null;
    const rs = await st.call(4, "mm_search_products", { query: "trứng", page_size: 10 });
    check("S2.guest_search", () => {
      assert.ok(rs.ok, rs.why);
      assert.ok(!rs.isError, "live search must succeed");
      const p = JSON.parse(rs.text);
      assert.ok(Array.isArray(p.products), "products array");
      assert.ok(p.products.length > 0 && p.products.length <= 10, "nonempty page within the requested page size");
      assert.ok(p.products.every((r) => Number.isSafeInteger(r.id) && r.id > 0 && typeof r.sku === "string" && r.sku !== "" && typeof r.name === "string" && r.name !== "" && typeof r.unit === "string" && r.unit !== "" && typeof r.stock_status === "string" && Number.isSafeInteger(r.quantity_step) && r.quantity_step >= 1 && vndRow(r)), "every row complete + valid VND");
      const skus = p.products.map((r) => r.sku);
      assert.equal(new Set(skus).size, skus.length, "no duplicate sku on the page");
      assert.ok(p.products.every((r) => typeof r.url_key === "string" && URL_KEY_RE.test(r.url_key)), "every search row carries a valid slug");
      assert.deepEqual(p.context, { store_code: process.env.MM_STORE_CODE, authenticated: false }, "guest context = the one configured store, never authenticated");
      assert.equal(p.price_status, "catalog-observed-not-guaranteed-payable");
      assert.ok(isoOk(st, p.observed_at), "observed_at inside the session window");
      assert.ok(Number.isSafeInteger(p.pagination.total_count) && p.pagination.total_count >= p.products.length, "observed total_count covers the page (mutable — no fixed count asserted)");
      assert.deepEqual({ page_index: p.pagination.page_index, page_size: p.pagination.page_size }, { page_index: 0, page_size: 10 });
      searchPage = p;
      return { rows: p.products.length, total_count: p.pagination.total_count, store: p.context.store_code };
    });
    const rd = searchPage ? await st.call(5, "mm_get_product", { url_key: searchPage.products[0].url_key, expected_sku: searchPage.products[0].sku }) : null;
    check("S2.guest_detail", () => {
      assert.ok(searchPage, "successful nonempty guest search required");
      assert.ok(rd.ok, rd.why);
      assert.ok(!rd.isError, "detail for the search row must succeed");
      const p = JSON.parse(rd.text);
      assert.ok(isObj(p.product), "product object");
      assert.ok(typeof p.product.url_key === "string" && URL_KEY_RE.test(p.product.url_key), "valid canonical slug");
      assert.equal(p.product.sku, searchPage.products[0].sku, "expected_sku matched (fails closed otherwise)");
      assert.ok(moneyOk(p.product.price_vnd) && moneyOk(p.product.regular_price_vnd) && p.product.price_vnd <= p.product.regular_price_vnd, "valid VND");
      assert.deepEqual(p.context, searchPage.context, "same guest store: guest detail is NOT account pricing");
      assert.equal(p.price_status, "catalog-observed-not-guaranteed-payable");
      assert.ok(isoOk(st, p.observed_at));
      return { detail: true };
    });

    // authenticated: real calls, once each — actual proof, store consistency, cart validated twice, independently
    const ra = await st.call(6, "mm_auth_status", {});
    let storeCode = null;
    check("S2.auth_status_actual", () => {
      assert.ok(ra.ok, ra.why);
      assert.ok(!ra.isError, "auth proof must succeed (live)");
      const p = JSON.parse(ra.text);
      assert.deepEqual(Object.keys(p).sort(), ["authenticated", "observed_at", "store_code", "store_name"], "exact projection keys");
      assert.equal(p.authenticated, true, "ACTUAL upstream proof of a customer — never assumed");
      assert.ok(/^b2c_[0-9]{1,8}_vi$/.test(p.store_code) && typeof p.store_name === "string" && p.store_name !== "");
      assert.ok(isoOk(st, p.observed_at), "observed_at inside the session window");
      storeCode = p.store_code;
      return { authenticated: true, store: storeCode };
    });
    const rc = await st.call(7, "mm_get_delivery_context", {});
    check("S2.delivery_context_consistent", () => {
      assert.ok(rc.ok, rc.why);
      assert.ok(!rc.isError);
      const p = JSON.parse(rc.text);
      assert.equal(p.store_code, storeCode, "same store as mm_auth_status (each answered live, consistent)");
      assert.match(p.address_selection, /^NOT verified: /, "selection never inferred from stored data");
      assert.ok(isoOk(st, p.observed_at));
      assert.ok(!("addresses" in p), "no address rows in a context view");
      return { consistent: true };
    });
    const rr = await st.call(8, "mm_list_addresses", { page_index: 0, page_size: 20 });
    check("S2.addresses_valid", () => {
      assert.ok(rr.ok, rr.why);
      assert.ok(!rr.isError);
      const p = JSON.parse(rr.text);
      assert.ok(Array.isArray(p.addresses), "addresses array");
      assert.ok(p.addresses.length <= 20, "never over the requested page size");
      assert.ok(p.addresses.every((a) => isObj(a) && Object.keys(a).sort().join(",") === "city,custom_attributes,default_shipping,id,street"), "exact row keys — no identity fields");
      // street/city arrive as scalar-or-list (live rows carry street as a one-element
      // list): shape-checked structurally, scalar TYPES are not pinned from a guess
      const textish = (v) => v === null || v === "" || (typeof v === "string") || (Array.isArray(v) && v.every((x) => typeof x === "string"));
      assert.ok(p.addresses.every((a) => textish(a.street) && textish(a.city) && typeof a.default_shipping === "boolean" && Array.isArray(a.custom_attributes) && a.custom_attributes.every((x) => isObj(x) && typeof x.attribute_code === "string")), "row fields valid");
      const ids = p.addresses.map((a) => String(a.id));
      assert.equal(new Set(ids).size, ids.length, "no duplicate address id");
      assert.ok(Number.isSafeInteger(p.pagination.total_count) && p.pagination.total_count >= p.addresses.length, "total_count observed and covers the page (mutable — no fixed count asserted)");
      assert.ok(Number.isSafeInteger(p.pagination.total_pages) && p.pagination.total_pages >= 0);
      assert.deepEqual({ page_index: p.pagination.page_index, page_size: p.pagination.page_size }, { page_index: 0, page_size: 20 });
      assert.deepEqual(p.context, { store_code: storeCode, authenticated: true }, "authenticated context, same store");
      assert.ok(isoOk(st, p.observed_at));
      return { count: p.addresses.length, total_count: p.pagination.total_count };
    });
    const rt = await st.call(9, "mm_get_cart", {});
    check("S2.cart_valid", () => {
      assert.ok(rt.ok, rt.why);
      assert.ok(!rt.isError, "cart read must succeed");
      const p = JSON.parse(rt.text);
      assert.ok(Array.isArray(p.items), "items array");
      assert.ok(p.items.every(cartLineOk), "every line complete + valid");
      const uids = p.items.map((l) => l.uid);
      assert.equal(new Set(uids).size, uids.length, "no duplicate line uid");
      assert.ok(p.total_quantity === 0 || qtyOk(p.total_quantity), "total_quantity >= 0 (0 = real empty cart, valid)");
      assert.ok(totalsOk(p.totals ?? {}), "totals: non-negative VND, observed not recomputed");
      assert.ok(shipOk(p.shipping), "shipping: count + labels valid");
      assert.match(p.price_status, /^cart-observed-not-guaranteed-payable/);
      assert.deepEqual(p.context, { store_code: storeCode, authenticated: true }, "authenticated context, same store");
      assert.ok(isoOk(st, p.observed_at));
      assert.ok(!/cart_id/i.test(JSON.stringify(p)), "no cart id anywhere (owner lookup)");
      return { lines: p.items.length, total_quantity: p.total_quantity, address_count: p.shipping.address_count };
    });
    const rsu = await st.call(10, "mm_cart_summary", {});
    check("S2.summary_valid_independent", () => {
      assert.ok(rsu.ok, rsu.why);
      assert.ok(!rsu.isError, "summary read must succeed");
      const p = JSON.parse(rsu.text);
      assert.ok(Number.isSafeInteger(p.line_count) && p.line_count >= 0, "line_count observed (may differ from the cart call only via concurrent edits — equality not claimed)");
      assert.ok(p.total_quantity === 0 || qtyOk(p.total_quantity));
      assert.ok(totalsOk(p), "summary totals: non-negative VND, observed");
      assert.ok(shipOk(p.shipping));
      assert.match(p.price_status, /not recomputed/);
      assert.deepEqual(p.context, { store_code: storeCode, authenticated: true }, "same store as every other authenticated answer");
      assert.ok(isoOk(st, p.observed_at));
      assert.ok(!("items" in p), "summary carries no line rows");
      assert.ok(!/cart_id/i.test(JSON.stringify(p)), "no cart id anywhere");
      return { line_count: p.line_count, exact_cart_equality_not_claimed: true };
    });

    const cl = await st.close();
    check("S2.clean_exit", () => {
      assert.equal(cl.code, 0, "clean exit after stdin close");
      assert.ok(st.stderrClean, "no stderr noise from the server (content never printed)");
      assert.equal(st.orphans, 0, "no unsolicited/duplicate frames");
      return { exit: true, stderr_clean: true };
    });
  }

  console.log(`${passed}/${checks} checks passed`);
  process.exit(passed === checks ? 0 : 1);
}

// import as a library (e.g. from the test harness) => no main run, no real calls,
// no temp state; direct run => execute the gate.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log(`FAIL GATE ${e && (e.name || "ERR")}`);
    console.log(`${passed}/${checks} checks passed`);
    clean();
    process.exit(1);
  });
}

export { spawnGate };
