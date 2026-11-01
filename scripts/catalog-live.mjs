#!/usr/bin/env node
// Public live gate: the REAL MCP server on stdio, real endpoint, GUEST only (no
// credential, no account/cart call, nothing written). One child, one request -> one
// reply, via the same bounded harness the account gate uses (spawnGate from
// ./account-live.mjs: CALL_TIMEOUT, 2 MiB stdout cap, orphan counting, bounded close).
//
// Explicit MM_STORE_CODE required (no silent default). Guest MM_AUTH_FILE points at a
// nonexistent path so no credential can leak into this session by inheritance.
//
// Checks MUTABLE invariants, never fixed values: no asserted row count, no asserted
// price, no asserted ordering, no known-SKU claim. Observed values are printed as facts.
// An authenticated tool is out of scope here (scripts/account-live.mjs owns those).
//
// stdout: "PASS <id> <safe facts>" / "FAIL <id> <fixed why>" + one summary line.
// Safe facts = booleans / counts / store code / observed prices (public catalog data).
//
// Offline coverage: scripts/catalog-live.test.mjs runs this gate against FAKE children
// (no network, deterministic). `npm run live` runs it against the real endpoint.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGate } from "./account-live.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");
const PV = "2024-11-05";
const TOOL_NAMES = [
  "mm_search_products", "mm_get_product", "mm_auth_status", "mm_get_delivery_context",
  "mm_list_addresses", "mm_get_cart", "mm_cart_summary",
];
const PRICE_STATUS = "catalog-observed-not-guaranteed-payable";
// search answers with products+pagination; detail answers with a single product (no pagination)
const SEARCH_KEYS = ["context", "observed_at", "pagination", "price_status", "products"];
const DETAIL_KEYS = ["context", "observed_at", "price_status", "product"];
const URL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const moneyOk = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const qtyOk = (v) => typeof v === "number" && Number.isFinite(v) && v > 0; // step may be fractional (0.5)
const isoFresh = (s, spawnedAt) => {
  const t = Date.parse(s);
  return !Number.isNaN(t) && t >= spawnedAt && t <= Date.now() + 5000;
};

const rowOk = (p) =>
  Number.isSafeInteger(p.id) && p.id > 0
  && typeof p.sku === "string" && p.sku !== ""
  && typeof p.name === "string" && p.name !== ""
  && typeof p.unit === "string" && p.unit !== ""
  && typeof p.stock_status === "string" && p.stock_status !== ""
  && typeof p.url_key === "string" && URL_KEY_RE.test(p.url_key)
  && qtyOk(p.quantity_step)
  && moneyOk(p.price_vnd) && moneyOk(p.regular_price_vnd) && p.price_vnd <= p.regular_price_vnd;

// Search/detail projections: exact top-level keys, guest context for the configured
// store, valid rows, no secret-shaped text. Search adds internally consistent pagination.
function envelopeOk(proj, store, spawnedAt, keys) {
  assert.deepEqual(Object.keys(proj).sort(), keys, "projection keys");
  assert.deepEqual(proj.context, { store_code: store, authenticated: false }, "guest context, configured store");
  assert.equal(proj.price_status, PRICE_STATUS, "price_status");
  assert.ok(isoFresh(proj.observed_at, spawnedAt), "observed_at inside [spawn, now]");
  const dump = JSON.stringify(proj);
  assert.ok(!/cookie|authorization|token|secret|Bearer\s/i.test(dump), "projection carries no secrets");
}

function searchOk(proj, store, spawnedAt, pageIndex, pageSize) {
  envelopeOk(proj, store, spawnedAt, SEARCH_KEYS);
  const pg = proj.pagination;
  assert.ok(isObj(pg), "pagination object");
  assert.equal(pg.page_index, pageIndex, "page_index echoed");
  assert.equal(pg.page_size, pageSize, "page_size echoed");
  assert.ok(Number.isSafeInteger(pg.total_count) && pg.total_count > 0, "total_count positive");
  assert.ok(Number.isSafeInteger(pg.total_pages) && pg.total_pages >= Math.ceil(pg.total_count / pageSize), "total_pages covers total_count");
  assert.ok(Array.isArray(proj.products) && proj.products.length > 0, "must return products");
  assert.ok(proj.products.length <= Math.min(pageSize, pg.total_count), "rows never exceed page size / total");
  for (const p of proj.products) assert.ok(rowOk(p), "complete valid row: " + JSON.stringify(p).slice(0, 160));
  const skus = proj.products.map((p) => p.sku);
  assert.equal(new Set(skus).size, skus.length, "no duplicate sku on a page");
}

function detailOk(proj, store, spawnedAt, row) {
  envelopeOk(proj, store, spawnedAt, DETAIL_KEYS);
  assert.ok(isObj(proj.product), "one product object");
  assert.ok(rowOk(proj.product), "detail row valid");
  // called WITH expected_sku, so identity is bound by SKU: the slug may legitimately be the
  // canonical one instead of the search alias (server documents both). It must never be junk.
  assert.equal(proj.product.sku, row.sku, "sku bound by expected_sku");
  assert.ok(URL_KEY_RE.test(proj.product.url_key), "detail slug is a usable slug");
}

// Runs the gate against one child (real server for `npm run live`, a fake in the tests).
// Nothing here is a fixed business value: counts and prices are observed, then reported.
export async function runGate({ store, cmd, env }) {
  if (typeof store !== "string" || store === "") {
    return { refused: "MM_STORE_CODE must be set explicitly, e.g. MM_STORE_CODE=b2c_10010_vi node scripts/catalog-live.mjs", checks: [] };
  }
  const guestEnv = { ...env, MM_STORE_CODE: store, MM_AUTH_FILE: path.join(os.tmpdir(), `mmguest-${process.pid}`, "auth.json") };
  const st = spawnGate(guestEnv, cmd);
  const checks = [];
  const report = (id, facts) => {
    try {
      const f = facts();
      checks.push({ id, ok: true, facts: f ?? {} });
    } catch (e) {
      checks.push({ id, ok: false, why: (e && (e.message || e.code || e.name)) || "ERR" });
    }
  };

  const init = st.strict(await st.ask(1, "initialize", { protocolVersion: PV, clientInfo: { name: "live-gate", version: "1" }, capabilities: {} }), 1);
  report("G.init_ok", () => {
    assert.ok(init.ok, init.why);
    assert.equal(init.fr.result.protocolVersion, PV);
    assert.deepEqual(init.fr.result.serverInfo, { name: "mm-mcp", version: "0.1.0" });
    return { init: true };
  });

  st.notify("notifications/initialized"); // per protocol a notification owes no reply
  // Naming here is deliberate: this proves request correlation SURVIVED the notification
  // boundary (the next id is answered intact), NOT that the notification was suppressed.
  // Suppression itself is proven only by the session-wide orphan count in G.clean_exit.
  const ping = st.strict(await st.ask(2, "ping"), 2);
  report("G.ping_answered_after_notification", () => {
    assert.ok(ping.ok, ping.why);
    assert.deepEqual(ping.fr.result, {});
    return { ping_answered: true };
  });

  const list = st.strict(await st.ask(3, "tools/list"), 3);
  report("G.tools_list_exact", () => {
    assert.ok(list.ok, list.why);
    const tools = list.fr.result.tools;
    assert.ok(Array.isArray(tools), "tools array");
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), "exactly the published tools");
    for (const t of tools) {
      assert.ok(typeof t.description === "string" && t.description.length > 20, `${t.name} description`);
      assert.ok(isObj(t.inputSchema) && t.inputSchema.type === "object" && t.inputSchema.additionalProperties === false, `${t.name} inputSchema`);
    }
    return { count: tools.length };
  });

  const page0 = await st.call(4, "mm_search_products", { query: "trứng", page_index: 0, page_size: 24 });
  let proj0 = null;
  report("G.search_page0", () => {
    assert.ok(page0.ok, page0.why);
    assert.ok(!page0.isError, "guest search must succeed: " + page0.text.slice(0, 160));
    proj0 = JSON.parse(page0.text);
    searchOk(proj0, store, st.spawnedAt, 0, 24);
    const seen = proj0.products.map((p) => `${p.sku} ${p.price_vnd}${p.price_vnd < p.regular_price_vnd ? "/" + p.regular_price_vnd : ""}`);
    return { rows: proj0.products.length, total_count: proj0.pagination.total_count, total_pages: proj0.pagination.total_pages, store, observed: seen };
  });

  const page1 = await st.call(5, "mm_search_products", { query: "trứng", page_index: 1, page_size: 24 });
  report("G.search_page1", () => {
    assert.ok(page1.ok, page1.why);
    assert.ok(!page1.isError, "page 2 guest search must succeed: " + page1.text.slice(0, 160));
    const proj = JSON.parse(page1.text);
    searchOk(proj, store, st.spawnedAt, 1, 24);
    // cross-page overlap is NOT asserted: upstream may reorder between calls (mutable data)
    return { rows: proj.products.length, page_index: proj.pagination.page_index };
  });

  // search -> detail link, guest: a url_key issued on page 0 must resolve in this store
  let detail = null;
  if (proj0 && proj0.products.length) {
    const row = proj0.products[0];
    detail = await st.call(6, "mm_get_product", { url_key: row.url_key, expected_sku: row.sku });
    report("G.detail_from_search", () => {
      assert.ok(detail.ok, detail.why);
      assert.ok(!detail.isError, "detail of a search-issued url_key must resolve: " + detail.text.slice(0, 160));
      const d = JSON.parse(detail.text);
      detailOk(d, store, st.spawnedAt, row);
      return { detail: true, sku: row.sku, search_slug_was_alias: d.product.url_key !== row.url_key };
    });
  } else {
    report("G.detail_from_search", () => { throw new Error("no page 0 row to link from"); });
  }

  const unknown = st.strict(await st.ask(7, "tools/call", { name: "no_such_tool", arguments: {} }), 7);
  report("G.unknown_tool", () => {
    assert.ok(unknown.ok, unknown.why);
    const e = unknown.fr.error;
    assert.ok(isObj(e), "an unknown tool must answer a JSON-RPC error, not a tool result");
    assert.equal(e.code, -32602, "unknown tool is invalid params");
    assert.match(e.message, /^unknown tool: /, "the tool name is named, nothing else");
    return { invalid_params: true };
  });

  const badArgs = await st.call(8, "mm_search_products", { query: "x", bogus: 1 });
  report("G.bad_args_rejected", () => {
    assert.ok(badArgs.ok, badArgs.why);
    assert.ok(badArgs.isError, "an unknown argument must fail closed, not be ignored");
    assert.match(badArgs.text, /^INVALID_ARGS\b/, "one stable code");
    return { invalid_args: true };
  });

  const cl = await st.close();
  report("G.clean_exit", () => {
    assert.equal(cl.code, 0, "clean exit after stdin close");
    assert.ok(st.stderrClean, "no stderr noise from the server (content never printed)");
    assert.equal(st.orphans, 0, "no unsolicited/duplicate frames");
    return { exit: true, stderr_clean: true };
  });

  return { checks, refused: null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checks } = await runGate({ store: process.env.MM_STORE_CODE, cmd: [process.execPath, SERVER], env: process.env });
  if (!checks.length) {
    console.log("REFUSED (no child spawned)");
    process.exit(1);
  }
  let passed = 0;
  for (const c of checks) {
    if (c.ok) { passed += 1; console.log(`PASS ${c.id} ${JSON.stringify(c.facts)}`); }
    else console.log(`FAIL ${c.id} ${c.why}`);
  }
  console.log(`${passed}/${checks.length} checks passed`);
  process.exit(passed === checks.length ? 0 : 1);
}
