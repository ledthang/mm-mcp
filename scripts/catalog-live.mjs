#!/usr/bin/env node
// Live gate: spawn the real MCP server on stdio and search "trứng" against the real
// endpoint. Explicit MM_STORE_CODE required (no silent default). Asserts protocol shape
// and per-row validity; reports OBSERVED values only (count, prices) and never asserts a
// mutable value (prices/total_count/first-row ordering can move). Known-SKU identity is
// checked only when that SKU is actually present. Prints the public projection only.
// No detail/auth/cart tools exist (sku:{eq} filter proven ignored upstream), so no such call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");
const PV = "2024-11-05";
const CHILD_TIMEOUT = 40000; // server caps one request at 25s; leave headroom
const KNOWN_SKU = "120167_21201677"; // from the 2026-10-31 capture; identity only if present

const store = process.env.MM_STORE_CODE;
if (!store) {
  console.error("refusing: MM_STORE_CODE must be set explicitly, e.g. MM_STORE_CODE=b2c_10010_vi node scripts/catalog-live.mjs");
  process.exit(1);
}

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MM_STORE_CODE: store } });
let buf = "";
const frames = [];
const waiters = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let f;
    try { f = JSON.parse(line); } catch { f = { badFrame: line.slice(0, 200) }; }
    const w = waiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(f); } else { frames.push(f); }
  }
});
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => stderr.push(c));

// One request line -> exactly one reply with the same id (a stray reply for a
// notification, or an id mismatch, fails the awaiting assert).
function ask(id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  return new Promise((resolve) => {
    const w = { resolve, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); resolve(null); } }, CHILD_TIMEOUT) };
    if (frames.length) { clearTimeout(w.timer); resolve(frames.shift()); } else waiters.push(w);
  });
}
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
const vndRow = (p) => Number.isSafeInteger(p.price_vnd) && p.price_vnd > 0
  && Number.isSafeInteger(p.regular_price_vnd) && p.regular_price_vnd > 0
  && p.price_vnd <= p.regular_price_vnd;
const rowOk = (p) => typeof p.sku === "string" && p.sku !== ""
  && Number.isSafeInteger(p.id) && p.id > 0
  && typeof p.name === "string" && p.name !== ""
  && typeof p.unit === "string" && p.unit !== ""
  && typeof p.stock_status === "string" && p.stock_status !== ""
  && Number.isSafeInteger(p.quantity_step) && p.quantity_step >= 1
  && vndRow(p);

async function main() {
  const init = await ask(1, "initialize", { protocolVersion: PV, clientInfo: { name: "live-gate", version: "1" }, capabilities: {} });
  assert.ok(init, "initialize must answer");
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, PV);
  assert.deepEqual(init.result.serverInfo, { name: "mm-mcp", version: "0.1.0" });

  const list = await ask(2, "tools/list");
  assert.equal(list.id, 2);
  assert.equal(list.result.tools.length, 1, "single tool");
  assert.equal(list.result.tools[0].name, "mm_search_products");

  const search = await ask(3, "tools/call", { name: "mm_search_products", arguments: { query: "trứng" } });
  assert.equal(search.id, 3);
  assert.ok(!search.result.isError, "live search must succeed, got: " + JSON.stringify(search.result.content?.[0]?.text).slice(0, 200));
  const proj = JSON.parse(search.result.content[0].text);

  assert.ok(Array.isArray(proj.products) && proj.products.length > 0, "must return products");
  for (const p of proj.products) assert.ok(rowOk(p), "complete valid row: " + JSON.stringify(p).slice(0, 160));
  assert.deepEqual(Object.keys(proj).sort(), ["context", "observed_at", "pagination", "price_status", "products"]);
  assert.deepEqual(proj.context, { store_code: store, authenticated: false }, "guest context, configured store");
  assert.equal(proj.price_status, "catalog-observed-not-guaranteed-payable");
  assert.ok(!Number.isNaN(Date.parse(proj.observed_at)));
  assert.ok(Number.isSafeInteger(proj.pagination.total_count) && proj.pagination.total_count > 0, "observed total_count positive");
  assert.ok(Number.isSafeInteger(proj.pagination.total_pages) && proj.pagination.total_pages > 0);
  assert.deepEqual({ page_index: proj.pagination.page_index, page_size: proj.pagination.page_size }, { page_index: 0, page_size: 24 });
  assert.ok(proj.products.length <= proj.pagination.page_size, "rows never exceed requested page size");
  const skus = proj.products.map((p) => p.sku);
  assert.equal(new Set(skus).size, skus.length, "no duplicate sku on a page");

  // known SKU from the capture: identity only, and only when present (no ordering claim)
  const known = proj.products.find((p) => p.sku === KNOWN_SKU);
  if (known) {
    assert.equal(known.name, "Trứng gà tươi CP, hộp 10 quả, 61-67g", "known SKU identity (name/unit)");
    assert.equal(known.unit, "Hộp", "unit preserved verbatim");
  }

  const bad = await ask(4, "tools/call", { name: "mm_search_products", arguments: { query: "x", bogus: 1 } });
  assert.equal(bad.id, 4);
  assert.equal(bad.result.isError, true, "unknown arg must fail");
  assert.match(bad.result.content[0].text, /^INVALID_ARGS/);

  notify("notifications/initialized");
  const ping = await ask(5, "ping");
  assert.equal(ping.id, 5, "notification must not produce its own reply");
  assert.deepEqual(ping.result, {});

  const dump = JSON.stringify(proj);
  assert.ok(!/cookie|authorization|token|secret/i.test(dump), "projection carries no secrets");

  console.log(dump); // only stdout: the public projection (observed prices included)
  const seen = proj.products.map((p) => `${p.sku} ${p.price_vnd}${p.price_vnd < p.regular_price_vnd ? "/" + p.regular_price_vnd : ""}`).join(" ");
  console.error(`live gate: initialize+tools/list+search(trứng)+validation OK; ${proj.products.length}/${proj.pagination.total_count} rows store=${store}; observed ${seen}`);
  child.stdin.end();
  const code = await new Promise((res) => child.once("close", (c) => res(c)));
  assert.equal(code, 0);
  assert.equal(stderr.join("").trim(), "", "no stderr noise from server");
  process.exit(0);
}

main().catch((e) => {
  console.error("LIVE GATE FAIL", e && e.message);
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  process.exit(1);
});
