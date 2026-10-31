#!/usr/bin/env node
// mm-mcp catalog tests: injected fetch fixtures, node:assert only, serial.
// Search (mm_search_products): proves mapping (CARD->ENRICH join), shuffled enrichment,
// mismatched/missing/duplicate SKUs, GraphQL errors, malformed price/currency, arg/env
// validation, timeout, body caps.
// Detail (mm_get_product): proves the captured ProductPage request bytes (query verbatim,
// one JSON variable, store header, exactly one request), the projection, and the
// exact-match rules (not found / wrong url_key / multiple / SKU mismatch) fail closed.
// Fixtures are real Response objects (undici) so res.body/cancel semantics are the real
// ones, not hand-rolled mocks. No real network here; scripts/catalog-live.mjs is the gate.
// Security section (failure redaction): every failure is one fixed code with nothing on
// stderr; unknown throws are exactly INTERNAL. { raw: ... } stubs cover the spots a real
// Response cannot fail at (a headers object that throws / has no get).
import assert from "node:assert/strict";
import { createCatalog, DETAIL_QUERY } from "../src/catalog.mjs";

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
const cardItem = (id, sku, name, unit, step = 1, stock = "IN_STOCK", url_key = "") => ({
  id, sku, name, unit_ecom: unit, mm_qty_step: step, stock_status: stock, url_key,
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
const A = { card: cardItem(69667, "120167_21201677", "Trứng gà tươi CP, hộp 10 quả, 61-67g", "Hộp", 1, "IN_STOCK", "trung-ga-tuoi-cp-hop-10-qua-120167"),
            enrich: enrichItem("120167_21201677", 31000, 31000, "Mua từ 3 giảm 4.84%") };
const B = { card: cardItem(69669, "145667_21456671", "Trứng gà tươi CP, khay 30 quả, 54-60g", "Khay", 1, "IN_STOCK", "trung-ga-tuoi-cp-khay-30-qua-54-60g"),
            enrich: enrichItem("145667_21456671", 89000, 89000) };
const C = { card: cardItem(69678, "197560_21975608", "Trứng gà ta Vĩnh Thành Đạt, hộp 10 quả, 60g", "Hộp", 1, "IN_STOCK", "trung-ga-ta-vinh-thanh-dat-hop-10-qua-60g"),
            enrich: enrichItem("197560_21975608", 42400, 42400) };
const OK_PAGE = [CARD([A.card, B.card, C.card]), ENR([A.enrich, B.enrich, C.enrich])];

// --- detail fixture: the captured ProductPage answer (public guest data, store
// b2c_10010_vi), pared to the fields the projection reads. No bulky dump.
const DETAIL_URL_KEY = "trung-ga-tuoi-cp-hop-10-qua-120167";
const TIER = { qty: "3", promo_label: "Mua từ 3", promo_type: "P", promo_amount: 4.84, promo_value: 28095, event_id: "D263193094", event_name: "Mua từ 3 giảm 4.84%", __typename: "DnrPrice" };
const detailItem = (over = {}) => ({
  id: 69667,
  uid: "Njk2Njc=",
  __typename: "SimpleProduct",
  name: "Trứng gà tươi CP, hộp 10 quả, 61-67g",
  sku: "120167_21201677",
  url_key: DETAIL_URL_KEY,
  unit_ecom: "Hộp",
  mm_qty_step: 1,
  stock_status: "IN_STOCK",
  price: { regularPrice: { amount: { currency: "VND", value: 31000, __typename: "Money" }, __typename: "Price" }, __typename: "ProductPrices" },
  price_range: {
    maximum_price: {
      final_price: { currency: "VND", value: 31000, __typename: "Money" },
      discount: { amount_off: 0, percent_off: 0, __typename: "ProductDiscount" },
      __typename: "ProductPrice",
    },
    __typename: "PriceRange",
  },
  dnr_price: [TIER],
  dnr_mcard: null,
  ...over,
});
const DETAIL = (items) => ({ data: { products: { items } } });

// One fixture entry = one HTTP response to hand out (fresh per call, body never re-read).
// spec: <payload object> (json, HTTP 200) | { status, <payload> } | { chunks: [Buffer],
// contentLength? } (streamed body; highWaterMark 0 so pull == a real read) |
// { throws: <value> } (fetch throws this value, Error or not) |
// { raw: <object> } (prebuilt response-ish object, may be a stub: headers/body can throw).
function mkFetch(specs, env = { MM_STORE_CODE: "b2c_10010_vi" }) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const spec = specs[Math.min(n, specs.length - 1)];
    const rec = { url: String(url), init, pulls: 0, cancelled: false };
    calls.push(rec);
    n += 1;
    if (spec instanceof Error) throw spec;
    if (spec.throws !== undefined) throw spec.throws; // any value, Error or not
    if (spec.raw) return spec.raw; // hand-rolled response-like object: headers/body may throw
    const status = spec.status ?? 200;
    if (spec.chunks) {
      let i = 0;
      const headers = spec.contentLength ? { "content-length": String(spec.contentLength) } : {};
      const stream = new ReadableStream({
        pull(c) {
          rec.pulls += 1;
          if (i < spec.chunks.length) c.enqueue(spec.chunks[i++]);
          else if (spec.streamError) c.error(new Error(spec.streamError)); // stream dies on the next read
          else c.close();
        },
        cancel() { rec.cancelled = true; },
      }, { highWaterMark: 0 });
      return new Response(stream, { status, headers });
    }
    return new Response(JSON.stringify(spec.json ?? spec), { status });
  };
  const cat = createCatalog({ fetchImpl, env });
  return {
    cat,
    calls,
    run: (args = { query: "trứng" }) => cat.callTool("mm_search_products", args),
    runDetail: (args) => cat.callTool("mm_get_product", args),
  };
}
const text = (env) => env.content[0].text;
// GraphQL selection check (brace-counted, exact): true only if `field` is selected inside
// the first `outer` selection set of `path` ("" = whole document). A plain .includes()
// on the query string proves nothing — nested copies are not the item being shown.
function selectsIn(query, path, field) {
  let scope = query;
  for (const owner of path) {
    const next = selectIn(scope, owner);
    if (next === "") return false;
    scope = next;
  }
  let depth = 0;
  for (const token of scope.match(/[_A-Za-z][_0-9A-Za-z]*|[{}]/g) ?? []) {
    if (token === "{") depth++;
    else if (token === "}") depth--;
    else if (depth === 1 && token === field) return true;
  }
  return false;
}
function selectIn(scope, owner) {
  const at = scope.indexOf(owner + "{");
  if (at === -1) return "";
  let open = 1;

  let k = at + owner.length + 1;
  for (; open > 0 && k < scope.length; k++) {
    if (scope[k] === "{") open++;
    else if (scope[k] === "}") open--;
  }
  return open === 0 ? scope.slice(at, k) : "";
}

const payload = (env) => JSON.parse(text(env));
const MB = 1024 * 1024;
// FAKE secret canary, used only in injected failure text/streams to prove nothing raw leaks
// to the caller and nothing is logged. Not a credential for anything.
const CANARY = "sk_live_FAKE_9f3b7a2c4e6d";
// One callTool round with process.stderr captured (the harness PASS/FAIL lines are written
// outside this window, so anything collected here came from the request path).
async function captureStderr(call) {
  const real = process.stderr.write;
  let err = "";
  process.stderr.write = (chunk, enc, cb) => {
    err += String(chunk);
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") done.call(process.stderr);
    return true;
  };
  try {
    return { out: await call(), err };
  } finally {
    process.stderr.write = real;
  }
}

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
      url_key: "trung-ga-tuoi-cp-hop-10-qua-120167",
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

  // --- mm_get_product (captured ProductPage contract, exact url_key) ---
  await t("detail: exact request bytes (query verbatim, one JSON variable, store header, one call)", async () => {
    const { runDetail, calls } = mkFetch([DETAIL([detailItem()])]);
    const out = await runDetail({ url_key: DETAIL_URL_KEY });
    assert.equal(out.isError, undefined, "success has no isError: " + text(out));
    assert.equal(calls.length, 1, "exactly one request: no CARD/ENRICH on the detail path");
    const u = new URL(calls[0].url);
    assert.equal(u.origin, "https://online.mmvietnam.com", "fixed origin");
    assert.equal(u.pathname, "/graphql");
    assert.equal(u.searchParams.get("query"), DETAIL_QUERY, "captured query, verbatim");
    assert.ok(u.searchParams.get("query").includes("url_key:{eq:$urlKey}") && u.searchParams.get("query").includes("show_disabled:true"), "exact url_key filter + show_disabled");
    assert.ok(!u.searchParams.get("query").includes(DETAIL_URL_KEY), "argument never interpolated into the query");
    const q = u.searchParams.get("query");
    const answerPath = ["fragment ProductDetailsFragment on ProductInterface", "price_range", "maximum_price"];
    const answerFragment = selectIn(q, answerPath[0]);
    const answerMax = selectIn(selectIn(answerFragment, "price_range"), "maximum_price");
    assert.notEqual(answerMax, "", "answer price_range.maximum_price block exists");
    assert.ok(selectsIn(q, answerPath, "regular_price"),
      "answer price_range.maximum_price selects regular_price directly");
    const strippedFragment = answerFragment.replace(answerMax,
      answerMax.replace(selectIn(answerMax, "regular_price"), ""));
    const stripped = q.replace(answerFragment, strippedFragment);
    assert.ok(stripped !== q, "negative control document built");
    assert.ok(!selectsIn(stripped, answerPath, "regular_price"),
      "negative control: answer block lost regular_price");
    assert.ok(stripped.indexOf("regular_price{", stripped.indexOf("similar_products{")) !== -1,
      "negative control: nested similar_products copy still selects regular_price, so only the answer block changed");
    assert.ok(q.includes("render_stage:CARD") === false, "detail document is not the search document");
    assert.deepEqual(JSON.parse(u.searchParams.get("variables")), { urlKey: DETAIL_URL_KEY }, "one JSON variable, serialized");
    assert.deepEqual(Object.keys(calls[0].init.headers), ["store"], "only the store header");
    assert.equal(calls[0].init.headers.store, "b2c_10010_vi");
    assert.ok(!("method" in calls[0].init) || calls[0].init.method === "GET", "GET");
    assert.equal(calls[0].init.signal.constructor.name, "AbortSignal");
  });

  await t("detail: projection + context + price_status, raw offers never payable", async () => {
    const mcard = { event_id: "MC1", event_name: "Giá hội viên", promo_type: "PCT", promo_value: 10, cta: "shop", __typename: "DnrMcard" };
    const { runDetail, calls } = mkFetch([DETAIL([detailItem({ dnr_mcard: mcard })])]);
    const p = JSON.parse(text(await runDetail({ url_key: DETAIL_URL_KEY })));
    assert.deepEqual(p.product, {
      id: 69667,
      sku: "120167_21201677",
      name: "Trứng gà tươi CP, hộp 10 quả, 61-67g",
      url_key: DETAIL_URL_KEY,
      unit: "Hộp",
      quantity_step: 1,
      stock_status: "IN_STOCK",
      price_vnd: 31000,
      regular_price_vnd: 31000,
      promotion: [TIER],
      member_offer: mcard,
    });
    assert.deepEqual(Object.keys(p).sort(), ["context", "observed_at", "price_status", "product"]);
    assert.deepEqual(p.context, { store_code: "b2c_10010_vi", authenticated: false }, "guest context");
    assert.equal(p.price_status, "catalog-observed-not-guaranteed-payable");
    assert.ok(!Number.isNaN(Date.parse(p.observed_at)));
    assert.ok("member_offer" in p.product && p.product.price_vnd === 31000, "offer kept raw, price untouched");
    assert.equal(calls.length, 1, "detail never touches the search stages");
  });

  await t("detail: expected_sku accepted on exact match, SKU_MISMATCH fail closed", async () => {
    const ok = mkFetch([DETAIL([detailItem()])]);
    const p = JSON.parse(text(await ok.runDetail({ url_key: DETAIL_URL_KEY, expected_sku: "120167_21201677" })));
    assert.equal(p.product.sku, "120167_21201677");
    assert.equal(ok.calls.length, 1);
    const bad = mkFetch([DETAIL([detailItem()])]);
    const out = await bad.runDetail({ url_key: DETAIL_URL_KEY, expected_sku: "99999_99999" });
    assert.equal(out.isError, true);
    assert.match(text(out), /^SKU_MISMATCH: 120167_21201677 != 99999_99999$/);
    assert.equal(bad.calls.length, 1, "no retry after a mismatch");
  });

  await t("detail: zero matches -> PRODUCT_NOT_FOUND (no retry)", async () => {
    const { runDetail, calls } = mkFetch([DETAIL([])]);
    const out = await runDetail({ url_key: "khong-ton-tai-xyz" });
    assert.equal(out.isError, true);
    assert.equal(text(out), "PRODUCT_NOT_FOUND: no product for url_key khong-ton-tai-xyz");
    assert.equal(calls.length, 1);
  });

  await t("detail: another product's url_key answer is not the requested product", async () => {
    const { runDetail, calls } = mkFetch([DETAIL([detailItem({ url_key: "some-other-product" })])]);
    const out = await runDetail({ url_key: DETAIL_URL_KEY });
    assert.equal(text(out), "PRODUCT_NOT_FOUND: returned url_key is not the requested one");
    assert.equal(calls.length, 1);
  });

  // Grouped: CARD url_key validation. A card slug must be a usable same-store slug or the
  // whole search fails closed BEFORE the ENRICH stage (an unvalidated slug would hand the
  // caller a detail link that cannot resolve, and ENRICH prices for a row we reject anyway).
  await t("search url_key validation: missing/empty/malformed slug fail closed before ENRICH; valid slug projected unchanged", async () => {
    // missing / empty / malformed path slugs: no row without a valid slug is emitted.
    for (const bad of [undefined, "", "../x"]) {
      const card = { ...C.card };
      if (bad === undefined) delete card.url_key; else card.url_key = bad;
      const { run, calls } = mkFetch([CARD([card, A.card, B.card]), ENR([C.enrich, A.enrich, B.enrich])]);
      const out = await run();
      assert.equal(out.isError, true, "must fail closed: " + JSON.stringify(bad));
      assert.match(text(out), /^BAD_UPSTREAM_DATA: card item url_key$/);
      assert.equal(calls.length, 1, "ENRICH never called for " + JSON.stringify(bad));
    }
    // valid slug: projected byte-for-byte unchanged (never rewritten, lowercased or invented)
    const { run, calls } = mkFetch(OK_PAGE);
    const p = payload(await run());
    assert.deepEqual(p.products.map((x) => x.url_key), [
      "trung-ga-tuoi-cp-hop-10-qua-120167", "trung-ga-tuoi-cp-khay-30-qua-54-60g",
      "trung-ga-ta-vinh-thanh-dat-hop-10-qua-60g",
    ], "slugs passed through unchanged");
    assert.equal(calls.length, 2, "valid rows do reach ENRICH");
  });

  // Alias hop: search hands out an alias slug, detail serves a canonical slug for the
  // same SKU. Accepted ONLY with a matching expected_sku; never an invented slug.
  await t("detail: alias slug accepted with matching expected_sku, canonical slug projected", async () => {
    const ALIAS = "trung-ga-tuoi-cp-hop-10-qua";
    const CANON = "trung-ga-cp-hop-10-s-21201677-120167";
    const { runDetail, calls } = mkFetch([DETAIL([detailItem({ url_key: CANON })])]);
    const p = JSON.parse(text(await runDetail({ url_key: ALIAS, expected_sku: "120167_21201677" })));
    assert.equal(p.product.url_key, CANON, "upstream canonical slug returned, never the requested alias");
    assert.equal(p.product.sku, "120167_21201677");
    assert.deepEqual(p.context, { store_code: "b2c_10010_vi", authenticated: false }, "same store, guest");
    assert.equal(calls.length, 1, "one request, no fallback lookup");
    assert.deepEqual(Object.keys(p.product).sort(), ["id", "member_offer", "name", "price_vnd", "promotion", "quantity_step", "regular_price_vnd", "sku", "stock_status", "unit", "url_key"], "exact projection keys, no new flag");
  });

  // Without expected_sku the caller has no identity proof: strict slug equality stays.
  await t("detail: slug mismatch without expected_sku -> PRODUCT_NOT_FOUND, no guessing", async () => {
    const CANON = "trung-ga-cp-hop-10-s-21201677-120167";
    const { runDetail, calls } = mkFetch([DETAIL([detailItem({ url_key: CANON })])]);
    const out = await runDetail({ url_key: "trung-ga-tuoi-cp-hop-10-qua" });
    assert.equal(out.isError, true);
    assert.equal(text(out), "PRODUCT_NOT_FOUND: returned url_key is not the requested one");
    assert.equal(calls.length, 1, "no retry, no second lookup by sku");
  });

  // expected_sku binds identity only when it matches; slug equality does not excuse it.
  await t("detail: wrong expected_sku -> SKU_MISMATCH even when slug matches", async () => {
    const { runDetail, calls } = mkFetch([DETAIL([detailItem()])]);
    const out = await runDetail({ url_key: DETAIL_URL_KEY, expected_sku: "99999_99999" });
    assert.equal(out.isError, true);
    assert.match(text(out), /^SKU_MISMATCH: 120167_21201677 != 99999_99999$/);
    assert.equal(calls.length, 1, "no retry");
  });

  // The slug that comes back must be usable in this store, in every accepted branch.
  await t("detail: malformed canonical slug rejected, also under matching expected_sku", async () => {
    // malformed slug answer + matching expected_sku: still refused, the hop is not opened
    const bad = mkFetch([DETAIL([detailItem({ url_key: "trung ga cp hop" })])]);
    const out = await bad.runDetail({ url_key: "trung-ga-tuoi-cp-hop-10-qua", expected_sku: "120167_21201677" });
    assert.equal(out.isError, true);
    assert.equal(text(out), "BAD_UPSTREAM_DATA: product url_key");
    assert.equal(bad.calls.length, 1, "no retry");
    // malformed slug answer without expected_sku: the strict path names the same failure
    const strict = mkFetch([DETAIL([detailItem({ url_key: "trung/ga/cp" })])]);
    assert.equal(text(await strict.runDetail({ url_key: DETAIL_URL_KEY })),
      "PRODUCT_NOT_FOUND: returned url_key is not the requested one");
  });

  await t("detail: several items for one exact filter -> MULTIPLE_PRODUCTS fail closed", async () => {
    const { runDetail, calls } = mkFetch([DETAIL([detailItem(), detailItem({ id: 69668, sku: "120167_21201678" })])]);
    const out = await runDetail({ url_key: DETAIL_URL_KEY });
    assert.equal(text(out), "MULTIPLE_PRODUCTS: 2 products for one exact url_key");
    assert.equal(calls.length, 1);
  });

  await t("detail: malformed money -> PRICE_INVALID (currency, type, fraction, negative, missing, final>regular)", async () => {
    const badMoneys = [
      { currency: "USD", value: 31000 },
      { currency: "VND", value: "31000" },
      { currency: "VND", value: 30999.5 },
      { currency: "VND", value: -1 },
      { currency: "VND", value: null },
      undefined,
    ];
    for (const fin of badMoneys) {
      const it = structuredClone(detailItem());
      if (fin === undefined) delete it.price_range.maximum_price.final_price;
      else it.price_range.maximum_price.final_price = fin;
      const { runDetail, calls } = mkFetch([DETAIL([it])]);
      const out = await runDetail({ url_key: DETAIL_URL_KEY });
      assert.equal(out.isError, true, "must fail closed: " + JSON.stringify(fin));
      assert.match(text(out), /^PRICE_INVALID: 120167_21201677 malformed price$/);
      assert.equal(calls.length, 1);
    }
    const it = structuredClone(detailItem());
    it.price.regularPrice.amount = { currency: "VND", value: "31000" };
    const r1 = mkFetch([DETAIL([it])]);
    assert.match(text(await r1.runDetail({ url_key: DETAIL_URL_KEY })), /^PRICE_INVALID: 120167_21201677 malformed price$/);
    const it2 = structuredClone(detailItem());
    it2.price_range.maximum_price.final_price = { currency: "VND", value: 32000, __typename: "Money" }; // above regular 31000
    const r2 = mkFetch([DETAIL([it2])]);
    assert.match(text(await r2.runDetail({ url_key: DETAIL_URL_KEY })), /^PRICE_INVALID: 120167_21201677 final above regular$/);
  });

  await t("detail: incomplete upstream item -> BAD_UPSTREAM_DATA", async () => {
    for (const items of [[null], [undefined], [{ ...detailItem(), id: "69667" }, ], [{ ...detailItem(), unit_ecom: "" }]]) {
      const { runDetail, calls } = mkFetch([DETAIL(items)]);
      const out = await runDetail({ url_key: DETAIL_URL_KEY });
      assert.equal(out.isError, true, "must fail closed: " + JSON.stringify(items).slice(0, 80));
      assert.match(text(out), /^BAD_UPSTREAM_DATA/);
      assert.equal(calls.length, 1);
    }
    const missing = mkFetch([{ data: {} }]);
    assert.equal(text(await missing.runDetail({ url_key: DETAIL_URL_KEY })), "BAD_UPSTREAM_DATA: products.items");
  });

  await t("detail: argument validation, zero network", async () => {
    const bads = [
      {}, { url_key: "" }, { url_key: 42 }, { url_key: true }, { url_key: "x".repeat(201) },
      { url_key: "a/b" }, { url_key: "/lead" }, { url_key: "a?b" }, { url_key: "a&b" }, { url_key: "a%b" },
      { url_key: "a b" }, { url_key: "abc\u0000" }, { url_key: "abc\u007f" }, { url_key: "trứng" },
      { url_key: DETAIL_URL_KEY, expected_sku: "" }, { url_key: DETAIL_URL_KEY, expected_sku: 42 },
      { url_key: DETAIL_URL_KEY, expected_sku: "x".repeat(65) }, { url_key: DETAIL_URL_KEY, expected_sku: "a\u001fb" },
      { url_key: DETAIL_URL_KEY, page_size: 24 }, { url_key: DETAIL_URL_KEY, query: "x" },
    ];
    for (const a of bads) {
      const { runDetail, calls } = mkFetch([DETAIL([detailItem()])]);
      const out = await runDetail(a);
      assert.equal(out.isError, true, "must reject " + JSON.stringify(a));
      assert.match(text(out), /^INVALID_ARGS/);
      assert.equal(calls.length, 0, "no upstream for invalid args: " + JSON.stringify(a));
    }
    const ok200 = mkFetch([DETAIL([detailItem({ url_key: "k".repeat(200) })])]);
    const p = JSON.parse(text(await ok200.runDetail({ url_key: "k".repeat(200) })));
    assert.equal(p.product.url_key, "k".repeat(200), "200 chars is in bounds");
  });

  await t("detail: store env missing/invalid -> no network, guest context on success", async () => {
    const noEnv = mkFetch([DETAIL([detailItem()])], {});
    assert.equal(text(await noEnv.runDetail({ url_key: DETAIL_URL_KEY })), "MISSING_STORE_ENV: MM_STORE_CODE is required, no default");
    assert.equal(noEnv.calls.length, 0);
    const badStore = mkFetch([DETAIL([detailItem()])], { MM_STORE_CODE: "b2c_10010_en" });
    assert.equal(text(await badStore.runDetail({ url_key: DETAIL_URL_KEY })), "INVALID_STORE_CODE");
    assert.equal(badStore.calls.length, 0);
  });

  await t("detail: upstream failures map to fixed codes, single attempt, streams released", async () => {
    const to = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const ab = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const cases = [
      [{ status: 500, chunks: [Buffer.from("boom")] }, "UPSTREAM_HTTP_STATUS: HTTP 500"],
      [{ json: { errors: [{ message: "upstream said no" }] } }, "GRAPHQL_ERRORS: 1 error(s)"],
      [to, "UPSTREAM_TIMEOUT"],
      [ab, "UPSTREAM_TIMEOUT"],
      [{ json: "<html>gate</html>" }, "RESPONSE_NOT_JSON"],
      [{ chunks: [Buffer.alloc(3 * MB)], contentLength: 3 * MB }, "RESPONSE_TOO_LARGE"],
      [{ chunks: [Buffer.alloc(MB, 97), Buffer.alloc(MB, 98), Buffer.alloc(MB, 99)] }, "RESPONSE_TOO_LARGE"],
      [new TypeError("fetch failed"), "UPSTREAM_UNREACHABLE"],
    ];
    for (const [spec, expect] of cases) {
      const { runDetail, calls } = mkFetch([spec]);
      assert.equal(text(await runDetail({ url_key: DETAIL_URL_KEY })), expect, "expected " + expect);
      assert.equal(calls.length, 1, "no retry storm for " + expect);
      if (spec.chunks || spec.status) assert.equal(calls[0].cancelled, true, "stream released: " + expect);
    }
  });

  // --- security contract: a failure is a fixed code and nothing else. Raw thrown text
  // (transport internals, header errors, body noise) is never echoed to the caller and never
  // written to stderr. CANARY is FAKE and injected by these fixtures only. ---
  await t("failure redaction: fixed code only, stderr silent (unknown throws => INTERNAL)", async () => {
    const stub = (over) => ({ ok: true, status: 200, headers: new Headers(), body: null, ...over });
    const SEARCH = { query: "trứng" };
    const DETAIL = { url_key: DETAIL_URL_KEY };
    // [label, spec, method, args, fixed code expected, stream cancelled expected (null = n/a)]
    const cases = [
      // transport layer: mapped fixed codes
      ["fetch throws transport error", new TypeError(`connect ECONNREFUSED 10.1.2.3:443 ${CANARY}`), "mm_search_products", SEARCH, "UPSTREAM_UNREACHABLE", null],
      ["fetch throws timeout", Object.assign(new Error(`deadline ${CANARY} hit`), { name: "TimeoutError" }), "mm_search_products", SEARCH, "UPSTREAM_TIMEOUT", null],
      ["fetch throws AbortError", Object.assign(new Error(`aborted ${CANARY}`), { name: "AbortError" }), "mm_get_product", DETAIL, "UPSTREAM_TIMEOUT", null],
      ["fetch throws a bare string", { throws: `transport said ${CANARY}` }, "mm_search_products", SEARCH, "UPSTREAM_UNREACHABLE", null],
      ["HTTP 500, canary body released unread", { status: 500, chunks: [Buffer.from(`upstream boom ${CANARY}`)] }, "mm_search_products", SEARCH, "UPSTREAM_HTTP_STATUS: HTTP 500", true],
      ["declared content-length over cap, body never read", { chunks: [Buffer.alloc(3 * MB)], contentLength: 3 * MB }, "mm_get_product", DETAIL, "RESPONSE_TOO_LARGE", true],
      ["body is not JSON", { json: `<html>${CANARY}</html>` }, "mm_search_products", SEARCH, "RESPONSE_NOT_JSON", null],
      // header layer: no mapping covers a headers object that throws -> exactly INTERNAL
      ["headers.get throws an Error", { raw: stub({ headers: { get() { throw new Error(`header cache ${CANARY} exploded`); } } }) }, "mm_search_products", SEARCH, "INTERNAL", null],
      ["headers.get throws a bare string", { raw: stub({ headers: { get() { throw `header cache ${CANARY} exploded`; } } }) }, "mm_get_product", DETAIL, "INTERNAL", null],
      ["headers has no get method", { raw: stub({ headers: {} }) }, "mm_search_products", SEARCH, "INTERNAL", null],
      // body layer: a stream that dies on read is mapped; a non-byte chunk or a throwing
      // byteLength escapes unmapped -> INTERNAL, and that un-read stream is never cancelled
      ["body stream dies mid-read", { chunks: [Buffer.from('{"data":')], streamError: `mid-stream ${CANARY}` }, "mm_search_products", SEARCH, "UPSTREAM_UNREACHABLE", false],
      ["body chunk is not bytes", { chunks: [42] }, "mm_search_products", SEARCH, "INTERNAL", false],
      ["body chunk byteLength throws", { chunks: [{ get byteLength() { throw new Error(`chunk ${CANARY} unreadable`); } }] }, "mm_get_product", DETAIL, "INTERNAL", false],
    ];
    for (const [label, spec, method, args, expect, cancelled] of cases) {
      const h = mkFetch([spec]);
      const { out, err } = await captureStderr(() => h.cat.callTool(method, args));
      assert.equal(out.isError, true, "must be an error envelope: " + label);
      assert.equal(text(out), expect, "fixed code only: " + label + " got " + JSON.stringify(text(out)));
      assert.ok(!text(out).includes(CANARY), "canary never echoed: " + label);
      assert.equal(err, "", "nothing logged: " + label + " got " + JSON.stringify(err.slice(0, 160)));
      assert.equal(h.calls.length, 1, "single attempt, no retry storm: " + label);
      if (cancelled !== null) assert.equal(h.calls[0].cancelled, cancelled, "stream release: " + label);
    }
  });

  await t("recovers after INTERNAL: next call still succeeds, stderr stays clean", async () => {
    const h = mkFetch([
      { raw: { ok: true, status: 200, headers: { get() { throw new Error(`header cache ${CANARY} exploded`); } }, body: null } },
      ...OK_PAGE,
    ]);
    const first = await captureStderr(() => h.cat.callTool("mm_search_products", { query: "trứng" }));
    assert.equal(text(first.out), "INTERNAL");
    assert.equal(first.err, "", "INTERNAL is not logged");
    const second = await captureStderr(() => h.cat.callTool("mm_search_products", { query: "trứng" }));
    assert.equal(second.out.isError, undefined, "recovers: " + text(second.out));
    assert.deepEqual(JSON.parse(text(second.out)).products.map((x) => x.sku), ["120167_21201677", "145667_21456671", "197560_21975608"]);
    assert.equal(second.err, "", "success path logs nothing");
    assert.equal(h.calls.length, 3, "failed call, then CARD + ENRICH");
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
