#!/usr/bin/env node
// mm-mcp catalog tests: injected fetch fixtures, node:assert only, serial.
// Proves mapping (CARD->ENRICH join), shuffled enrichment, mismatched/missing/duplicate
// SKUs, GraphQL errors, malformed price/currency, arg/env validation, timeout, body caps.
// Fixtures are real Response objects (undici) so res.body/cancel semantics are the real
// ones, not hand-rolled mocks. No real network here; scripts/catalog-live.mjs is the gate.
import assert from "node:assert/strict";
import { createCatalog } from "../src/catalog.mjs";

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

// --- fixtures from the captured contract (public guest data, store b2c_10010_vi) ---
const CARD = (items, total = 32, pages = 2) => ({ data: { products: { items, total_count: total, page_info: { total_pages: pages } } } });
const ENR = (items) => ({ data: { products: { items } } });
const cardItem = (id, sku, name, unit, step = 1, stock = "IN_STOCK") => ({
  id, sku, name, unit_ecom: unit, mm_qty_step: step, stock_status: stock,
});
const enrichItem = (sku, final, regular, promoName = null, mcard = null) => ({
  sku,
  categories: [],
  dnr_price_search_page: { event_id: promoName ? "D263193094" : null, event_name: promoName },
  dnr_mcard: mcard,
  price: { regularPrice: { amount: { value: regular, currency: "VND" } } },
  price_range: {
    maximum_price: {
      final_price: { currency: "VND", value: final },
      regular_price: { currency: "VND", value: regular },
      discount: { amount_off: final < regular ? regular - final : 0 },
    },
  },
});
const A = { card: cardItem(69667, "120167_21201677", "Trứng gà tươi CP, hộp 10 quả, 61-67g", "Hộp"),
            enrich: enrichItem("120167_21201677", 31000, 31000, "Mua từ 3 giảm 4.84%") };
const B = { card: cardItem(69669, "145667_21456671", "Trứng gà tươi CP, khay 30 quả, 54-60g", "Khay"),
            enrich: enrichItem("145667_21456671", 89000, 89000) };
const C = { card: cardItem(69678, "197560_21975608", "Trứng gà ta Vĩnh Thành Đạt, hộp 10 quả, 60g", "Hộp"),
            enrich: enrichItem("197560_21975608", 42400, 42400) };
const OK_PAGE = [CARD([A.card, B.card, C.card]), ENR([A.enrich, B.enrich, C.enrich])];

// One fixture entry = one HTTP response to hand out (fresh per call, body never re-read).
// spec: <payload object> (json, HTTP 200) | { status, <payload> } | { chunks: [Buffer],
// contentLength? } (streamed body; highWaterMark 0 so pull == a real read).
function mkFetch(specs, env = { MM_STORE_CODE: "b2c_10010_vi" }) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const spec = specs[Math.min(n, specs.length - 1)];
    const rec = { url: String(url), init, pulls: 0, cancelled: false };
    calls.push(rec);
    n += 1;
    if (spec instanceof Error) throw spec;
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
  const cat = createCatalog({ fetchImpl, env });
  return { cat, calls, run: (args = { query: "trứng" }) => cat.callTool("mm_search_products", args) };
}
const text = (env) => env.content[0].text;
const payload = (env) => JSON.parse(text(env));
const MB = 1024 * 1024;

async function main() {
  await t("search: exact request bytes (origin, variables, store, no cookies/auth)", async () => {
    const { run, calls } = mkFetch(OK_PAGE);
    const out = await run({ query: "trứng", page_index: 2, page_size: 10 });
    assert.equal(out.isError, undefined, "success has no isError: " + text(out));
    assert.equal(calls.length, 2, "CARD then ENRICH");
    const [card, enr] = calls;
    const u = new URL(card.url);
    assert.equal(u.origin, "https://online.mmvietnam.com", "fixed origin");
    assert.equal(u.pathname, "/graphql");
    assert.ok(u.searchParams.get("query").includes("render_stage:CARD"));
    assert.deepEqual(JSON.parse(u.searchParams.get("variables")), {
      currentPage: 3, pageSize: 10, filters: { category_uid: { in: [] } }, inputText: "trứng", asmUid: "", phoneNumber: "", sort: { relevance: "DESC" },
    }, "variables verbatim, currentPage = page_index + 1");
    assert.equal(card.init.headers.store, "b2c_10010_vi");
    assert.deepEqual(Object.keys(card.init.headers), ["store"], "only the store header");
    assert.ok(!Object.keys(card.init.headers).some((h) => /cookie|authorization/i.test(h)), "no cookies/auth");
    assert.equal(card.init.signal.constructor.name, "AbortSignal");
    assert.ok(!("method" in card.init) || card.init.method === "GET", "GET");
    const eu = new URL(enr.url);
    assert.ok(eu.searchParams.get("query").includes("render_stage:ENRICH"));
    assert.deepEqual(JSON.parse(eu.searchParams.get("variables")).skus,
      ["120167_21201677", "145667_21456671", "197560_21975608"], "ENRICH gets the exact CARD skus");
  });

  await t("projection fields + pagination + context + price_status", async () => {
    const { run } = mkFetch(OK_PAGE);
    const p = payload(await run());
    assert.deepEqual(p.products.map((x) => x.sku), ["120167_21201677", "145667_21456671", "197560_21975608"], "CARD order preserved");
    assert.deepEqual({ ...p.products[0] }, {
      id: 69667, sku: "120167_21201677", name: "Trứng gà tươi CP, hộp 10 quả, 61-67g", unit: "Hộp",
      quantity_step: 1, stock_status: "IN_STOCK", price_vnd: 31000, regular_price_vnd: 31000,
      promotion: "Mua từ 3 giảm 4.84%", member_offer: null,
    });
    assert.deepEqual(p.pagination, { total_count: 32, total_pages: 2, page_index: 0, page_size: 24 });
    assert.deepEqual(p.context, { store_code: "b2c_10010_vi", authenticated: false });
    assert.equal(p.price_status, "catalog-observed-not-guaranteed-payable");
    assert.ok(!Number.isNaN(Date.parse(p.observed_at)));
    assert.ok(!("member_price_vnd" in p.products[0]), "no payable-member-price invention");
  });

  await t("shuffled enrichment: join by exact sku still maps right", async () => {
    const { run } = mkFetch([OK_PAGE[0], ENR([C.enrich, A.enrich, B.enrich])]);
    const p = payload(await run());
    assert.deepEqual(p.products.map((x) => x.sku), ["120167_21201677", "145667_21456671", "197560_21975608"]);
    assert.deepEqual(p.products.map((x) => x.price_vnd), [31000, 89000, 42400]);
    assert.deepEqual(p.products.map((x) => x.unit), ["Hộp", "Khay", "Hộp"]);
  });

  await t("missing enrichment: fail closed, no unpriced rows", async () => {
    const { run, calls } = mkFetch([OK_PAGE[0], ENR([A.enrich, B.enrich])]);
    const out = await run();
    assert.equal(out.isError, true);
    assert.match(text(out), /^ENRICHMENT_INCOMPLETE: 1 sku\(s\) missing enrichment$/);
    assert.equal(calls.length, 2, "no retry storm");
  });

  await t("duplicate sku in enrichment: fail closed", async () => {
    const { run } = mkFetch([OK_PAGE[0], ENR([A.enrich, A.enrich, B.enrich, C.enrich])]);
    const out = await run();
    assert.equal(out.isError, true);
    assert.match(text(out), /^ENRICHMENT_INCOMPLETE: duplicate sku in enrichment$/);
  });

  await t("enrichment returns unrequested sku: fail closed", async () => {
    const { run } = mkFetch([OK_PAGE[0], ENR([A.enrich, B.enrich, C.enrich, enrichItem("99999_99999", 1, 1)])]);
    const out = await run();
    assert.equal(out.isError, true);
    assert.match(text(out), /^ENRICHMENT_INCOMPLETE: unexpected sku in enrichment$/);
  });

  await t("duplicate sku on CARD page: fail closed before ENRICH", async () => {
    const { run, calls } = mkFetch([CARD([A.card, A.card]), ENR([A.enrich])]);
    const out = await run();
    assert.match(text(out), /^ENRICHMENT_INCOMPLETE: duplicate sku on CARD page$/);
    assert.equal(calls.length, 1, "stopped at CARD");
  });

  await t("GraphQL error in CARD: GRAPHQL_ERRORS, ENRICH never called", async () => {
    const { run, calls } = mkFetch([{ json: { errors: [{ message: "some upstream error" }] } }]);
    const out = await run();
    assert.equal(out.isError, true);
    assert.equal(text(out), "GRAPHQL_ERRORS: 1 error(s)");
    assert.equal(calls.length, 1);
  });

  await t("malformed price: fail closed (USD, missing, fraction, negative, final>regular)", async () => {
    const bad = [
      { currency: "USD", value: 31000 },
      { currency: "VND", value: "31000" },
      { currency: "VND", value: 30999.5 },
      { currency: "VND", value: -1 },
      { currency: "VND", value: null },
    ];
    for (const fin of bad) {
      const e = structuredClone(A.enrich);
      e.price_range.maximum_price.final_price = fin;
      const { run } = mkFetch([OK_PAGE[0], ENR([e, B.enrich, C.enrich])]);
      const out = await run();
      assert.equal(out.isError, true, "must fail closed: " + JSON.stringify(fin));
      assert.match(text(out), /^PRICE_INVALID: 120167_21201677 malformed price$/);
    }
    const e = structuredClone(A.enrich);
    e.price_range.maximum_price.final_price.value = 32000; // above regular 31000
    const { run } = mkFetch([OK_PAGE[0], ENR([e, B.enrich, C.enrich])]);
    const out = await run();
    assert.match(text(out), /^PRICE_INVALID: 120167_21201677 final above regular$/);
  });

  await t("argument validation: INVALID_ARGS, zero network", async () => {
    const bads = [
      { query: "" }, { query: "x".repeat(101) }, { query: "abc\u0007" }, { query: 42 }, {},
      { query: "ok", foo: 1 }, { query: "ok", page_index: -1 }, { query: "ok", page_index: 41 },
      { query: "ok", page_index: 1.5 }, { query: "ok", page_index: "2" }, { query: "ok", page_size: 25 },
      { query: "ok", page_size: 0 }, { query: "ok", page_size: "24" }, { query: "ok", page_size: true },
    ];
    for (const a of bads) {
      const { run, calls } = mkFetch(OK_PAGE);
      const out = await run(a);
      assert.equal(out.isError, true, "must reject " + JSON.stringify(a));
      assert.match(text(out), /^INVALID_ARGS/);
      assert.equal(calls.length, 0, "no upstream for invalid args: " + JSON.stringify(a));
    }
  });

  await t("missing env: MISSING_STORE_ENV, zero network", async () => {
    const { run, calls } = mkFetch(OK_PAGE, {});
    const out = await run();
    assert.equal(text(out), "MISSING_STORE_ENV: MM_STORE_CODE is required, no default");
    assert.equal(calls.length, 0);
  });

  await t("invalid store codes: INVALID_STORE_CODE (empty: MISSING), zero network", async () => {
    for (const s of ["B2C_10010_vi", "b2c_vi", "b2c_10010", "b2c_123456789_vi", "b2c_10010_en", "x2c_1_vi", "b2c_0_vi_x", "b2c_10010_vi "]) {
      const { run, calls } = mkFetch(OK_PAGE, { MM_STORE_CODE: s });
      const out = await run();
      assert.match(text(out), /^INVALID_STORE_CODE/, "reject " + JSON.stringify(s));
      assert.equal(calls.length, 0);
    }
    for (const s of ["b2c_1_vi", "b2c_10010_vi", "b2c_99999999_vi"]) {
      const { run } = mkFetch(OK_PAGE, { MM_STORE_CODE: s });
      const p = payload(await run());
      assert.equal(p.context.store_code, s);
      assert.ok(!p.context.authenticated);
    }
  });

  await t("timeout before response: UPSTREAM_TIMEOUT, single attempt", async () => {
    const to = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { run, calls } = mkFetch([to]);
    const out = await run();
    assert.equal(text(out), "UPSTREAM_TIMEOUT");
    assert.equal(calls.length, 1);
  });

  await t("abort before response: UPSTREAM_TIMEOUT", async () => {
    const ab = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const { run, calls } = mkFetch([ab]);
    assert.equal(text(await run()), "UPSTREAM_TIMEOUT");
    assert.equal(calls.length, 1);
  });

  await t("network failure: UPSTREAM_UNREACHABLE", async () => {
    const { run, calls } = mkFetch([new TypeError("fetch failed")]);
    assert.equal(text(await run()), "UPSTREAM_UNREACHABLE");
    assert.equal(calls.length, 1);
  });

  await t("declared content-length over cap: refused without reading body", async () => {
    const { run, calls } = mkFetch([{ chunks: [Buffer.alloc(3 * MB)], contentLength: 3 * MB }]);
    const out = await run();
    assert.equal(text(out), "RESPONSE_TOO_LARGE");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pulls, 0, "body never read");
    assert.equal(calls[0].cancelled, true, "stream released");
  });

  await t("stream over cap, no content-length: stopped mid-stream, cancelled", async () => {
    const { run, calls } = mkFetch([{ chunks: [Buffer.alloc(MB, 97), Buffer.alloc(MB, 98), Buffer.alloc(MB, 99), Buffer.alloc(MB, 100)] }]);
    const out = await run();
    assert.equal(text(out), "RESPONSE_TOO_LARGE");
    assert.equal(calls[0].pulls, 3, "stopped at the chunk that crosses 2 MiB");
    assert.equal(calls[0].cancelled, true, "stream cancelled, no full allocation");
  });

  await t("HTTP 500: UPSTREAM_HTTP_STATUS, body released", async () => {
    const { run, calls } = mkFetch([{ status: 500, chunks: [Buffer.from("boom")] }]);
    const out = await run();
    assert.equal(text(out), "UPSTREAM_HTTP_STATUS: HTTP 500");
    assert.equal(calls.length, 1, "no retry");
    assert.equal(calls[0].cancelled, true);
  });

  await t("unparseable body: RESPONSE_NOT_JSON", async () => {
    const { run } = mkFetch([{ json: "<html>gate</html>" }]);
    assert.equal(text(await run()), "RESPONSE_NOT_JSON");
  });

  await t("empty result page: ok with no products, ENRICH skipped", async () => {
    const { run, calls } = mkFetch([CARD([], 0, 0)]);
    const p = payload(await run({ query: "zzzznothing" }));
    assert.deepEqual(p.products, []);
    assert.deepEqual(p.pagination, { total_count: 0, total_pages: 0, page_index: 0, page_size: 24 });
    assert.equal(calls.length, 1, "nothing to enrich");
  });

  await t("member offer: raw dnr_mcard kept, separate from payable price", async () => {
    const mcard = { event_id: "MC1", event_name: "Giá hội viên", promo_type: "PCT", promo_value: 10, cta: "shop" };
    const { run } = mkFetch([OK_PAGE[0], ENR([enrichItem("120167_21201677", 31000, 31000, null, mcard), B.enrich, C.enrich])]);
    const p = payload(await run());
    assert.deepEqual(p.products[0].member_offer, mcard);
    assert.equal(p.products[0].price_vnd, 31000, "member offer never becomes payable price");
  });

  await t("tools/call through server dispatch: envelope, unknown tool, notifications", async () => {
    const { dispatch } = await import("../src/server.mjs");
    const st = { initialized: true };
    const unknown = await dispatch(st, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }));
    assert.equal(unknown.error.code, -32602);
    assert.equal(unknown.error.message, "unknown tool: nope");
    const badArgs = await dispatch(st, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mm_search_products", arguments: { query: "x", extra: 1 } } }));
    assert.equal(badArgs.result.isError, true, "args failure is isError envelope");
    assert.match(badArgs.result.content[0].text, /^INVALID_ARGS/);
    const notif = await dispatch(st, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.equal(notif, null, "notifications: no reply, no dispatch");
  });

  console.error(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
