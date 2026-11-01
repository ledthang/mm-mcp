#!/usr/bin/env node
// Offline tests for the public live gate (scripts/catalog-live.mjs): FAKE children only.
// No real endpoint, no credential, no network. Deterministic; every wait is bounded by
// the reused spawnGate harness (CALL_TIMEOUT / CLOSE_GRACE / 2 MiB cap).
// Importing the gate launches nothing (its runner is guarded by the argv check).

import assert from "node:assert/strict";
import { runGate } from "./catalog-live.mjs";

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

const STORE = "b2c_teststore";
const ALL_IDS = ["G.init_ok", "G.ping_answered_after_notification", "G.tools_list_exact", "G.search_page0",
  "G.search_page1", "G.detail_from_search", "G.unknown_tool", "G.bad_args_rejected", "G.clean_exit"];

// Faithful fake: strict args (unknown key = INVALID_ARGS), unknown tool = JSON-RPC error,
// search envelope (products+pagination), detail envelope (single product, no pagination).
const FAKE_OK = `
const rl = require("readline").createInterface({ input: process.stdin });
const store = process.env.MM_STORE_CODE;
const PS = [10, 20, 24, 50];
const NAMES = ["mm_search_products","mm_get_product","mm_auth_status","mm_get_delivery_context","mm_list_addresses","mm_get_cart","mm_cart_summary"];
const TOOL_DESC = "live gate fake tool description long enough to pass the shape check";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function err(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function callOk(id, payload) { ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false }); }
function callErr(id, code) { ok(id, { content: [{ type: "text", text: code + " simulated" }], isError: true }); }
const TOTAL = 32;
function row(i) {
  const reg = 20000 + (i % 7) * 1500;
  const fin = reg - (i % 3) * 500;
  return {
    id: 9000 + i, sku: "SKU" + (1000 + i), name: "San pham " + i, url_key: "san-pham-" + i,
    unit: i % 2 ? "Hop" : "Kg", stock_status: "IN_STOCK",
    quantity_step: i % 4 === 0 ? 0.5 : 1, // fractional step is legitimate
    price_vnd: fin, regular_price_vnd: reg, promotion: null, member_offer: null,
  };
}
function page(pageIndex, pageSize) {
  const start = pageIndex * pageSize;
  const rows = [];
  for (let i = start; i < Math.min(start + pageSize, TOTAL); i++) rows.push(row(i));
  return {
    context: { store_code: store, authenticated: false },
    observed_at: new Date().toISOString(),
    pagination: { page_index: pageIndex, page_size: pageSize, total_count: TOTAL, total_pages: Math.ceil(TOTAL / pageSize) },
    price_status: "catalog-observed-not-guaranteed-payable",
    products: rows,
  };
}
function detail(i) {
  // FAKE_ALIAS=1 serves the product under a canonical slug that differs from the search alias
  const slug = process.env.FAKE_ALIAS === "1" ? "san-pham-" + i + "-canonical" : "san-pham-" + i;
  return {
    product: { ...row(i), url_key: slug },
    context: { store_code: store, authenticated: false },
    price_status: "catalog-observed-not-guaranteed-payable",
    observed_at: new Date().toISOString(),
  };
}
rl.on("line", (l) => {
  let r; try { r = JSON.parse(l); } catch (e) { return; }
  if (r.method === "initialize") return ok(r.id, { protocolVersion: "2024-11-05", serverInfo: { name: "mm-mcp", version: "0.1.0" }, capabilities: { tools: {} } });
  if (r.method === "notifications/initialized") return undefined; // notification: owes no reply
  if (r.method === "ping") {
    if (r.id === undefined) return undefined;
    if (Object.keys(r.params || {}).length > 0) return err(r.id, -32602, "ping takes no params");
    return ok(r.id, {});
  }
  if (r.method === "tools/list") {
    const p = r.params || {};
    if ("cursor" in p && !(typeof p.cursor === "string" && p.cursor.length > 0)) return err(r.id, -32602, "cursor must be a non-empty string");
    const listed = process.env.FAKE_ONE_TOOL ? ["mm_search_products"] : NAMES;
    return ok(r.id, { tools: listed.map((n) => ({ name: n, description: TOOL_DESC, inputSchema: { type: "object", properties: {}, additionalProperties: false } })) });
  }
  if (r.method === "tools/call") {
    const a = r.params.arguments || {};
    if (!NAMES.includes(r.params.name)) return err(r.id, -32602, "unknown tool: " + r.params.name);
    const extra = Object.keys(a).filter((k) => !["query", "page_index", "page_size", "url_key", "expected_sku"].includes(k));
    if (extra.length) return callErr(r.id, "INVALID_ARGS");
    if (r.params.name === "mm_search_products") {
      if (typeof a.query !== "string" || a.query.length === 0 || a.query.length > 100) return callErr(r.id, "INVALID_ARGS");
      const pi = a.page_index === undefined ? 0 : a.page_index;
      const ps = a.page_size === undefined ? 24 : a.page_size;
      if (!(Number.isInteger(pi) && pi >= 0 && pi <= 40)) return callErr(r.id, "INVALID_ARGS");
      if (!PS.includes(ps)) return callErr(r.id, "INVALID_ARGS");
      return callOk(r.id, page(pi, ps));
    }
    const k = a.url_key;
    if (typeof k !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(k)) return callErr(r.id, "INVALID_ARGS");
    const i = Number(k.split("-")[2]);
    if (!Number.isInteger(i)) return callErr(r.id, "INVALID_ARGS");
    if (a.expected_sku !== undefined && a.expected_sku !== "SKU" + (1000 + i)) return callErr(r.id, "SKU_MISMATCH");
    return callOk(r.id, detail(i));
  }
  return err(r.id, -32601, "Unknown method: " + r.method);
});
rl.on("close", () => process.exit(0));
`;

function gateOn(script, extraEnv = {}) {
  return runGate({ store: STORE, cmd: [process.execPath, "-e", script], env: { PATH: process.env.PATH, MM_STORE_CODE: STORE, ...extraEnv } });
}
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);

await t("refuses without an explicit store (no child spawned, every shape)", async () => {
  for (const store of [undefined, "", 42, true]) {
    const r = await runGate({ store, cmd: [process.execPath, "-e", FAKE_OK], env: {} });
    assert.deepEqual(r.checks, [], "no gate runs, so no checks");
    assert.match(r.refused, /MM_STORE_CODE must be set explicitly/);
  }
});

await t("gate passes end-to-end against a faithful fake server", async () => {
  const r = await gateOn(FAKE_OK);
  assert.deepEqual(failed(r), [], "all checks pass");
  assert.deepEqual(r.checks.map((c) => c.id), ALL_IDS);
  assert.equal(r.checks.find((c) => c.id === "G.tools_list_exact").facts.count, 7, "all 7 published tools, not a stale single-tool bar");
  const search = r.checks.find((c) => c.id === "G.search_page0");
  assert.equal(search.facts.rows, 24);
  assert.equal(search.facts.total_count, 32);
});

// --- failure modes: each must be caught, with a clean reason ----------------------------
await t("a single-tool server fails the tools check (the old stale bar is gone)", async () => {
  const r = await gateOn(FAKE_OK, { FAKE_ONE_TOOL: "1" });
  assert.deepEqual(failed(r), ["G.tools_list_exact"], "only the tools check fails; the session itself still works");
});
await t("an extra unpublished tool is caught", async () => {
  const r = await gateOn(FAKE_OK.replace('NAMES = ["mm_search_products"', 'NAMES = ["mm_search_products","mm_ghost"'));
  assert.ok(failed(r).includes("G.tools_list_exact"));
});
await t("a tool answered as a result instead of a JSON-RPC error is caught", async () => {
  const r = await gateOn(FAKE_OK.replace('if (!NAMES.includes(r.params.name)) return err(r.id, -32602, "unknown tool: " + r.params.name);', "if (!NAMES.includes(r.params.name)) return callErr(r.id, \"NOT_A_TOOL_RESULT\");"));
  assert.ok(failed(r).includes("G.unknown_tool"));
  assert.match(r.checks.find((c) => c.id === "G.unknown_tool").why, /JSON-RPC error, not a tool result/);
});
await t("duplicate SKU on a page is caught", async () => {
  const r = await gateOn(FAKE_OK.replace('sku: "SKU" + (1000 + i)', 'sku: "SKU" + (1000 + (i % 5))'));
  assert.ok(failed(r).includes("G.search_page0"));
});
await t("wrong store in the projection context is caught", async () => {
  const r = await gateOn(FAKE_OK.replace(/store_code: store/g, "store_code: 'b2c_other'"));
  assert.ok(failed(r).includes("G.search_page0"));
  assert.match(r.checks.find((c) => c.id === "G.search_page0").why, /guest context/);
});
await t("authenticated context on a guest call is caught", async () => {
  const r = await gateOn(FAKE_OK.replace(/authenticated: false/g, "authenticated: true"));
  assert.ok(failed(r).includes("G.search_page0"));
});
await t("price inversion (final above regular) is caught", async () => {
  const r = await gateOn(FAKE_OK.replace("price_vnd: fin, regular_price_vnd: reg", "price_vnd: reg + 100, regular_price_vnd: reg"));
  assert.ok(failed(r).includes("G.search_page0"));
});
await t("fractional quantity_step is accepted (0.5 is legitimate ordering)", async () => {
  const r = await gateOn(FAKE_OK.replace("quantity_step: i % 4 === 0 ? 0.5 : 1", "quantity_step: 0.5"));
  assert.deepEqual(failed(r), [], "a 0.5 step must not fail the row check");
});
await t("zero quantity_step is caught", async () => {
  const r = await gateOn(FAKE_OK.replace("quantity_step: i % 4 === 0 ? 0.5 : 1", "quantity_step: 0"));
  assert.ok(failed(r).includes("G.search_page0"));
});
await t("stale observed_at (year 2001) is caught", async () => {
  const r = await gateOn(FAKE_OK.replace(/observed_at: new Date\(\)\.toISOString\(\)/g, "observed_at: '2001-01-01T00:00:00.000Z'"));
  assert.ok(failed(r).includes("G.search_page0"));
});
await t("secret-shaped payload is caught", async () => {
  const r = await gateOn(FAKE_OK.replace(/promotion: null/g, "promotion: 'Bearer abcdef123456'"));
  assert.ok(failed(r).includes("G.search_page0"));
});
await t("page_size outside the published set is caught (24 removed from the fake set)", async () => {
  const r = await gateOn(FAKE_OK.replace("const PS = [10, 20, 24, 50];", "const PS = [10, 20, 50];"));
  assert.ok(failed(r).includes("G.search_page0"), "24 outside the server set must fail, not silently pass");
});
await t("unknown argument is refused by the server and caught by the gate", async () => {
  const loose = FAKE_OK.replace('const extra = Object.keys(a).filter((k) => !["query", "page_index", "page_size", "url_key", "expected_sku"].includes(k));', "const extra = [];");
  const r = await gateOn(loose);
  assert.ok(failed(r).includes("G.bad_args_rejected"), "a server that ignores an unknown argument fails the gate");
});
await t("detail bound to a different SKU is caught", async () => {
  const r = await gateOn(FAKE_OK.replace('if (a.expected_sku !== undefined && a.expected_sku !== "SKU" + (1000 + i)) return callErr(r.id, "SKU_MISMATCH");', "if (a.expected_sku !== undefined) return callErr(r.id, 'SKU_MISMATCH');"));
  assert.ok(failed(r).includes("G.detail_from_search"));
});
await t("detail answering with the search envelope is caught", async () => {
  const r = await gateOn(FAKE_OK.replace("return callOk(r.id, detail(i));", "return callOk(r.id, page(0, 1));"));
  assert.ok(failed(r).includes("G.detail_from_search"));
});
await t("a canonical slug (different from the search alias) is accepted when the SKU binds", async () => {
  const r = await gateOn(FAKE_OK, { FAKE_ALIAS: "1" });
  assert.deepEqual(failed(r), [], "alias -> canonical with matching sku is the documented path");
  assert.equal(r.checks.find((c) => c.id === "G.detail_from_search").facts.search_slug_was_alias, true);
});
await t("silent child that exits at once: every content check fails fast; only exit bookkeeping is clean", async () => {
  const t0 = Date.now();
  const r = await gateOn("process.exit(0);");
  assert.ok(Date.now() - t0 < 25000, "no 30 s clock waits: a dead child resolves at once");
  assert.equal(r.checks.length, ALL_IDS.length);
  assert.deepEqual(failed(r), ALL_IDS.filter((id) => id !== "G.clean_exit"), "nothing was answered, so nothing but the exit bookkeeping passes");
});
await t("stubborn child (ignores stdin end): close still bounded, clean_exit fails", async () => {
  const r = await gateOn(`
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  let r; try { r = JSON.parse(l); } catch (e) { return; }
  if (r.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n");
});
rl.on("close", () => { setInterval(() => {}, 1000); });
`);
  assert.ok(failed(r).includes("G.clean_exit"), "a child that survives the grace never exits cleanly");
});

console.error(`${checks - failures}/${checks} tests passed`);
process.exit(failures === 0 ? 0 : 1);
