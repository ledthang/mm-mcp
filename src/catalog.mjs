// MM Mega Market catalog: the two proven GraphQL stages only, per the 2026-10-31 capture
// (mm-search-contract.json, guest store b2c_10010_vi, HTTP 200 via native fetch GET +
// header store, no cookies): ProductSearch (render_stage CARD) lists products, then
// ProductSearchEnrich (render_stage ENRICH) prices the exact SKUs CARD returned, joined
// by exact sku. Query strings below are the captured strings, verbatim; variables are
// JSON-serialized per call and never built by string interpolation.
// Guest only: prices are catalog-observed, not guaranteed payable.
// mm_get_product is intentionally absent, not stubbed: the proof path (CARD request with
// filter sku:{eq:...}, empty search) was replayed and the filter is ignored upstream
// (returns the full 13k+ catalog, first item unrelated), so exact per-SKU detail is not
// a proven contract; search-by-sku would be search-as-detail, out of contract.

const GRAPHQL_URL = "https://online.mmvietnam.com/graphql";
const STORE_RE = /^b2c_[0-9]{1,8}_vi$/;
const PAGE_SIZES = [10, 20, 24, 50];
const TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PRICE_STATUS = "catalog-observed-not-guaranteed-payable";

// Verbatim from the 2026-10-31 capture (mm-search-contract.json), checked in.
export const CARD_QUERY = "query ProductSearch($currentPage:Int=1$inputText:String!$pageSize:Int=24$filters:ProductAttributeFilterInput!$sort:ProductAttributeSortInput$asmUid:String$phoneNumber:String){products(currentPage:$currentPage pageSize:$pageSize search:$inputText filter:$filters sort:$sort asm_uid:$asmUid phone_number:$phoneNumber render_stage:CARD){items{...ProductDisplayFragment tracking_url __typename}is_use_smart_search cdp_filter{label count attribute_code options{label value __typename}position __typename}aggregations{label count attribute_code options{label value __typename}position __typename}page_info{total_pages __typename}total_count __typename}}fragment ProductDisplayFragment on ProductInterface{id uid sku name ecom_name is_alcohol allow_pickup mis_stock{status label max_qty can_add_to_cart unavailable_reason notice __typename}mm_product_type mm_qty_step unit_ecom url_suffix art_no small_image{url __typename}rating_summary stock_status url_key canonical_url __typename}";
export const ENRICH_QUERY = "query ProductSearchEnrich($skus:[String]!$pageSize:Int=24$asmUid:String$phoneNumber:String){products(pageSize:$pageSize filter:{sku:{in:$skus}}asm_uid:$asmUid phone_number:$phoneNumber render_stage:ENRICH){items{...ProductEnrichFragment __typename}__typename}}fragment ProductEnrichFragment on ProductInterface{id uid sku categories{uid breadcrumbs{category_uid __typename}name __typename}dnr_price_search_page{event_id event_name __typename}dnr_mcard{event_id event_name promo_type promo_value cta __typename}price{regularPrice{amount{value currency __typename}__typename}__typename}price_range{maximum_price{final_price{currency value __typename}regular_price{currency value __typename}discount{amount_off __typename}__typename}__typename}product_label{label_id label_description label_name label_status label_from_date label_to_date label_priority label_type stores customer_groups product_image{type url position display text text_color text_font text_size shape_type shape_color label_size label_size_mobile custom_css use_default __typename}category_image{type url position display text text_color text_font text_size shape_type shape_color label_size label_size_mobile custom_css __typename}__typename}__typename}";

export const TOOLS = [
  {
    name: "mm_search_products",
    description:
      "Search the MM Mega Market online catalog (guest view, one explicit store). " +
      "Runs the captured two-stage contract: ProductSearch CARD listing, then " +
      "ProductSearchEnrich pricing of the exact returned SKUs. Prices are VND, " +
      "catalog-observed and NOT guaranteed payable. Guest store: member/MCard offers " +
      "are reported raw, never as your payable price. stock_status is a label, not an " +
      "inventory count or purchasability guarantee. No cart, no auth.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, description: "search text, 1-100 chars, no control characters" },
        page_index: { type: "integer", minimum: 0, maximum: 40, default: 0, description: "0-based page number; upstream currentPage = page_index + 1" },
        page_size: { type: "integer", enum: [10, 20, 24, 50], default: 24 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
const moneyOk = (m) => isObj(m) && m.currency === "VND" && Number.isSafeInteger(m.value) && m.value >= 0;

// Every failure is exactly one fixed code (+ optional safe detail): raw upstream bodies,
// queries and any account-looking content never reach the caller. Success and failure use
// the same MCP content envelope; failure additionally sets isError: true.
class CatalogError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export function createCatalog({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  // One complete stage request -> parsed GraphQL data object. Any transport/status/size/
  // JSON/graphql failure is a CatalogError; the response stream is always drained
  // (cancelled and awaited) before throwing so nothing dangles (no unhandled rejections,
  // no locked streams left behind).
  async function gql(query, variables, storeCode) {
    const url = new URL(GRAPHQL_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("variables", JSON.stringify(variables)); // serialized, never interpolated
    let res;
    try {
      res = await fetchImpl(url.toString(), { headers: { store: storeCode }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const name = e && typeof e === "object" ? e.name : undefined;
      if (name === "TimeoutError" || name === "AbortError") throw new CatalogError("UPSTREAM_TIMEOUT");
      throw new CatalogError("UPSTREAM_UNREACHABLE");
    }
    if (!res.ok) {
      if (res.body) { try { await res.body.cancel(); } catch { /* stream closed: nothing owed */ } }
      throw new CatalogError("UPSTREAM_HTTP_STATUS", `HTTP ${res.status}`);
    }
    // Declared size over cap: refuse without reading the body at all.
    const cl = Number(res.headers.get("content-length"));
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      if (res.body) { try { await res.body.cancel(); } catch { /* closed */ } }
      throw new CatalogError("RESPONSE_TOO_LARGE");
    }
    if (!res.body) throw new CatalogError("RESPONSE_NOT_JSON", "no response body");
    // Bound while streaming: stop once the running count crosses the cap, before any
    // full-buffer allocation of an oversized payload.
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        try { await reader.cancel(); } catch { /* closed */ }
        const name = e && typeof e === "object" ? e.name : undefined;
        if (name === "TimeoutError" || name === "AbortError") throw new CatalogError("UPSTREAM_TIMEOUT");
        throw new CatalogError("UPSTREAM_UNREACHABLE");
      }
      if (r.done) break;
      size += r.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* closed */ }
        throw new CatalogError("RESPONSE_TOO_LARGE");
      }
      parts.push(Buffer.from(r.value)); // copy: kept bytes are ours, not the transport's
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new CatalogError("RESPONSE_NOT_JSON");
    }
    if (!isObj(payload)) throw new CatalogError("RESPONSE_NOT_JSON");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new CatalogError("GRAPHQL_ERRORS", `${payload.errors.length} error(s)`);
    }
    if (!isObj(payload.data)) throw new CatalogError("RESPONSE_NOT_JSON", "no data object");
    return payload.data;
  }

  function validateArgs(raw) {
    if (!isObj(raw)) throw new CatalogError("INVALID_ARGS", "arguments must be an object");
    const unknown = Object.keys(raw).filter((k) => !["query", "page_index", "page_size"].includes(k));
    if (unknown.length) throw new CatalogError("INVALID_ARGS", `unknown argument(s): ${unknown.join(", ")}`);
    const q = raw.query;
    if (typeof q !== "string" || q.length < 1 || q.length > 100 || hasControl(q)) {
      throw new CatalogError("INVALID_ARGS", "query must be a 1-100 char string without control characters");
    }
    let pageIndex = 0;
    if ("page_index" in raw) {
      if (!isInt(raw.page_index, 0, 40)) throw new CatalogError("INVALID_ARGS", "page_index must be an integer 0..40");
      pageIndex = raw.page_index;
    }
    let pageSize = 24;
    if ("page_size" in raw) {
      if (!PAGE_SIZES.includes(raw.page_size)) throw new CatalogError("INVALID_ARGS", "page_size must be one of 10, 20, 24, 50");
      pageSize = raw.page_size;
    }
    return { query: q, pageIndex, pageSize };
  }

  // CARD stage -> exact SKUs -> ENRICH stage -> join by exact sku -> public projection.
  async function search(rawArgs) {
    const { query, pageIndex, pageSize } = validateArgs(rawArgs);
    const storeCode = env.MM_STORE_CODE;
    if (typeof storeCode !== "string" || storeCode === "") throw new CatalogError("MISSING_STORE_ENV", "MM_STORE_CODE is required, no default");
    if (!STORE_RE.test(storeCode)) throw new CatalogError("INVALID_STORE_CODE");

    const cardData = await gql(CARD_QUERY, {
      currentPage: pageIndex + 1, // observed upstream paging is 1-based
      pageSize,
      filters: { category_uid: { in: [] } },
      inputText: query,
      asmUid: "",
      phoneNumber: "",
      sort: { relevance: "DESC" },
    }, storeCode);
    const cards = cardData.products;
    if (!isObj(cards) || !Array.isArray(cards.items)) throw new CatalogError("BAD_UPSTREAM_DATA", "products.items");
    if (!isInt(cards.total_count, 0, Number.MAX_SAFE_INTEGER)) throw new CatalogError("BAD_UPSTREAM_DATA", "total_count");
    if (!isObj(cards.page_info) || !isInt(cards.page_info.total_pages, 0, Number.MAX_SAFE_INTEGER)) {
      throw new CatalogError("BAD_UPSTREAM_DATA", "page_info.total_pages");
    }
    const envelope = (products) => ({
      products,
      pagination: { total_count: cards.total_count, total_pages: cards.page_info.total_pages, page_index: pageIndex, page_size: pageSize },
      context: { store_code: storeCode, authenticated: false },
      price_status: PRICE_STATUS,
      observed_at: new Date().toISOString(),
    });
    if (cards.items.length === 0) return envelope([]); // empty page: nothing owes enrichment

    const skus = [];
    for (const it of cards.items) {
      if (!isObj(it) || typeof it.sku !== "string" || it.sku === "") throw new CatalogError("BAD_UPSTREAM_DATA", "card item sku");
      if (!isInt(it.id, 0, Number.MAX_SAFE_INTEGER)) throw new CatalogError("BAD_UPSTREAM_DATA", "card item id");
      if (typeof it.name !== "string" || it.name === "") throw new CatalogError("BAD_UPSTREAM_DATA", "card item name");
      if (typeof it.unit_ecom !== "string" || it.unit_ecom === "") throw new CatalogError("BAD_UPSTREAM_DATA", "card item unit_ecom");
      if (!isInt(it.mm_qty_step, 1, Number.MAX_SAFE_INTEGER)) throw new CatalogError("BAD_UPSTREAM_DATA", "card item mm_qty_step");
      if (typeof it.stock_status !== "string" || it.stock_status === "") throw new CatalogError("BAD_UPSTREAM_DATA", "card item stock_status");
      if (skus.includes(it.sku)) throw new CatalogError("ENRICHMENT_INCOMPLETE", "duplicate sku on CARD page");
      skus.push(it.sku);
    }

    const enrichData = await gql(ENRICH_QUERY, { skus, pageSize, asmUid: "", phoneNumber: "" }, storeCode);
    const enr = enrichData.products;
    if (!isObj(enr) || !Array.isArray(enr.items)) throw new CatalogError("BAD_UPSTREAM_DATA", "enrich items");
    const bySku = new Map();
    for (const it of enr.items) {
      if (!isObj(it) || typeof it.sku !== "string" || !skus.includes(it.sku)) throw new CatalogError("ENRICHMENT_INCOMPLETE", "unexpected sku in enrichment");
      if (bySku.has(it.sku)) throw new CatalogError("ENRICHMENT_INCOMPLETE", "duplicate sku in enrichment");
      bySku.set(it.sku, it);
    }
    if (bySku.size !== skus.length) throw new CatalogError("ENRICHMENT_INCOMPLETE", `${skus.length - bySku.size} sku(s) missing enrichment`);

    // build in CARD order so output order matches observed upstream order
    const listed = cards.items.map((it) => {
      const e = bySku.get(it.sku);
      const mp = isObj(e.price_range) ? e.price_range.maximum_price : null;
      const fin = isObj(mp) ? mp.final_price : null;
      const reg = isObj(mp) ? mp.regular_price : null;
      if (!moneyOk(fin) || !moneyOk(reg)) throw new CatalogError("PRICE_INVALID", `${it.sku} malformed price`);
      if (fin.value > reg.value) throw new CatalogError("PRICE_INVALID", `${it.sku} final above regular`);
      const promo = isObj(e.dnr_price_search_page) && typeof e.dnr_price_search_page.event_name === "string" ? e.dnr_price_search_page.event_name : null;
      return {
        id: it.id,
        sku: it.sku,
        name: it.name,
        unit: it.unit_ecom,
        quantity_step: it.mm_qty_step,
        stock_status: it.stock_status,
        price_vnd: fin.value,
        regular_price_vnd: reg.value,
        promotion: promo,
        member_offer: isObj(e.dnr_mcard) ? e.dnr_mcard : null, // raw offer data; never your payable price
      };
    });
    return envelope(listed);
  }

  async function callTool(name, args) {
    try {
      if (name !== "mm_search_products") throw new CatalogError("UNKNOWN_TOOL", String(name));
      const projection = await search(args);
      return { content: [{ type: "text", text: JSON.stringify(projection) }] };
    } catch (e) {
      const code = e instanceof CatalogError ? e.code : "INTERNAL";
      const detail = e instanceof CatalogError ? e.detail : String(e && e.message || "").slice(0, 200);
      if (!(e instanceof CatalogError)) process.stderr.write(`catalog internal: ${code} ${detail}\n`);
      return { content: [{ type: "text", text: detail ? `${code}: ${detail}` : code }], isError: true };
    }
  }

  return { callTool };
}
