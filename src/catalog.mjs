// MM Mega Market catalog: two proven contracts only, per the 2026-10-31 captures (guest
// store b2c_10010_vi, HTTP 200 via native fetch GET + header store, no cookies).
// Search (mm-search-contract.json): ProductSearch (render_stage CARD) lists products, then
// ProductSearchEnrich (render_stage ENRICH) prices the exact SKUs CARD returned, joined
// by exact sku. Detail (mm-detail-verified.json): the ProductPage query asks products by
// exact url_key with show_disabled:true and answers exactly one item. Detail is NOT
// search-as-detail: the earlier proof path (CARD with filter sku:{eq:...} and an empty
// search) was replayed and that filter is ignored upstream (the full 13k+ catalog comes
// back, first item unrelated), so the search contract could not carry exact detail.
// Query strings below are the captured strings, verbatim; variables are JSON-serialized
// per call and never built by string interpolation.
// Guest only: prices are catalog-observed, not guaranteed payable.

const GRAPHQL_URL = "https://online.mmvietnam.com/graphql";
const STORE_RE = /^b2c_[0-9]{1,8}_vi$/;
// url_key is a slug: ascii label chars only, so slash, query/fragment ('?', '&', '%'),
// whitespace and every control character are rejected before any request is made.
const URL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SKU_MAX = 64;
const PAGE_SIZES = [10, 20, 24, 50];
const TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PRICE_STATUS = "catalog-observed-not-guaranteed-payable";

// Verbatim from the 2026-10-31 capture (mm-search-contract.json), checked in.
export const CARD_QUERY = "query ProductSearch($currentPage:Int=1$inputText:String!$pageSize:Int=24$filters:ProductAttributeFilterInput!$sort:ProductAttributeSortInput$asmUid:String$phoneNumber:String){products(currentPage:$currentPage pageSize:$pageSize search:$inputText filter:$filters sort:$sort asm_uid:$asmUid phone_number:$phoneNumber render_stage:CARD){items{...ProductDisplayFragment tracking_url __typename}is_use_smart_search cdp_filter{label count attribute_code options{label value __typename}position __typename}aggregations{label count attribute_code options{label value __typename}position __typename}page_info{total_pages __typename}total_count __typename}}fragment ProductDisplayFragment on ProductInterface{id uid sku name ecom_name is_alcohol allow_pickup mis_stock{status label max_qty can_add_to_cart unavailable_reason notice __typename}mm_product_type mm_qty_step unit_ecom url_suffix art_no small_image{url __typename}rating_summary stock_status url_key canonical_url __typename}";
export const ENRICH_QUERY = "query ProductSearchEnrich($skus:[String]!$pageSize:Int=24$asmUid:String$phoneNumber:String){products(pageSize:$pageSize filter:{sku:{in:$skus}}asm_uid:$asmUid phone_number:$phoneNumber render_stage:ENRICH){items{...ProductEnrichFragment __typename}__typename}}fragment ProductEnrichFragment on ProductInterface{id uid sku categories{uid breadcrumbs{category_uid __typename}name __typename}dnr_price_search_page{event_id event_name __typename}dnr_mcard{event_id event_name promo_type promo_value cta __typename}price{regularPrice{amount{value currency __typename}__typename}__typename}price_range{maximum_price{final_price{currency value __typename}regular_price{currency value __typename}discount{amount_off __typename}__typename}__typename}product_label{label_id label_description label_name label_status label_from_date label_to_date label_priority label_type stores customer_groups product_image{type url position display text text_color text_font text_size shape_type shape_color label_size label_size_mobile custom_css use_default __typename}category_image{type url position display text text_color text_font text_size shape_type shape_color label_size label_size_mobile custom_css __typename}__typename}__typename}";

// Verbatim from the 2026-10-31 ProductPage capture (mm-detail-verified.json), checked in:
// exact url_key + show_disabled:true, NOT the search contract above; 0 or >1 answers fail closed.
// regular_price{currency value __typename} is added to the TOP-LEVEL price_range.maximum_price
// (the capture omitted it there). expected_sku binds the answer: on alias slug it must match.
export const DETAIL_QUERY = "query getProductDetailForProductPage($urlKey:String!){products(filter:{url_key:{eq:$urlKey}}show_disabled:true){items{id uid ...ProductDetailsFragment __typename}__typename}}fragment ProductDetailsFragment on ProductInterface{__typename categories{uid breadcrumbs{category_uid __typename}name __typename}main_category{uid id name breadcrumbs{category_uid category_level category_name category_url_key category_url_path __typename}__typename}description{html __typename}short_description{html __typename}id uid is_alcohol allow_pickup media_gallery_entries{uid label position disabled file video_content{video_url video_title __typename}__typename}meta_description url_suffix name ecom_name mis_stock{status label max_qty can_add_to_cart unavailable_reason notice __typename}mm_product_type mm_qty_step unit_ecom mm_brand dnr_price{qty promo_label promo_type promo_amount promo_value event_id event_name __typename}dnr_mcard{event_id event_name promo_type promo_value cta __typename}art_no price{regularPrice{amount{currency value __typename}__typename}__typename}price_range{maximum_price{final_price{currency value __typename}regular_price{currency value __typename}discount{amount_off percent_off __typename}__typename}__typename}sku small_image{url __typename}stock_status url_key canonical_url product_label{label_id label_description label_name label_status label_from_date label_to_date label_priority label_type stores customer_groups product_image{type url position display text text_color text_font text_size shape_type shape_color label_size label_size_mobile custom_css use_default __typename}category_image{type url position display text text_color text_font text_size shape_type shape_color label_size label_size_mobile custom_css __typename}__typename}rating_summary review_count reviews{items{average_rating ratings_breakdown{name value __typename}__typename}__typename}similar_products{uid sku name price_range{maximum_price{final_price{currency value __typename}regular_price{currency value __typename}discount{amount_off __typename}__typename}__typename}small_image{url __typename}url_key __typename}custom_attributes{selected_attribute_options{attribute_option{uid label is_default __typename}__typename}entered_attribute_value{value __typename}attribute_metadata{uid code label attribute_labels{store_code label __typename}data_type is_system entity_type ui_input{ui_input_type is_html_allowed __typename}...on ProductAttributeMetadata{used_in_components __typename}__typename}__typename}additional_attributes{attribute_code label value __typename}...on ConfigurableProduct{configurable_options{attribute_code attribute_id uid label values{uid default_label label store_label use_default_value value_index swatch_data{...on ImageSwatchData{thumbnail __typename}value __typename}__typename}__typename}variants{attributes{code value_index __typename}product{uid media_gallery_entries{uid disabled file label position __typename}sku stock_status price{regularPrice{amount{currency value __typename}__typename}__typename}price_range{maximum_price{final_price{currency value __typename}discount{amount_off __typename}__typename}__typename}custom_attributes{selected_attribute_options{attribute_option{uid label is_default __typename}__typename}entered_attribute_value{value __typename}attribute_metadata{uid code label attribute_labels{store_code label __typename}data_type is_system entity_type ui_input{ui_input_type is_html_allowed __typename}...on ProductAttributeMetadata{used_in_components __typename}__typename}__typename}__typename}__typename}__typename}}";

export const TOOLS = [
  {
    name: "mm_search_products",
    description:
      "Search the MM Mega Market online catalog (guest view, one explicit store). " +
      "Runs the captured two-stage contract: ProductSearch CARD listing, then " +
      "ProductSearchEnrich pricing of the exact returned SKUs. Prices are VND, " +
      "catalog-observed and NOT guaranteed payable. Guest store: member/MCard offers " +
      "are reported raw, never as your payable price. stock_status is a label, not an " +
      "inventory count or purchasability guarantee. Each row's url_key is a search slug " +
      "that may be an alias: pass it with the row's sku as expected_sku to mm_get_product " +
      "to reach the canonical detail. No cart, no auth.",
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
  {
    name: "mm_get_product",
    description:
      "Exact detail for one MM Mega Market product (guest view, one explicit store). " +
      "Runs the captured ProductPage query: products(filter:{url_key:{eq:<url_key>}}, " +
      "show_disabled:true) — an exact url_key lookup, not search. Fails closed unless " +
      "exactly one product comes back for that url_key. With expected_sku, identity is " +
      "bound by SKU: the call succeeds if the single answer's SKU equals expected_sku, " +
      "even when upstream serves it under a different (canonical) slug — that answer's " +
      "slug must still be a valid slug. A SKU that does not match is SKU_MISMATCH. " +
      "Without expected_sku the returned url_key must equal the requested one exactly. " +
      "Prices are VND, catalog-observed and NOT guaranteed payable " +
      "(price_vnd is the observed final price, regular_price_vnd the regular one); " +
      "promotion and member_offer are raw offer data, never your payable price. " +
      "stock_status is a label, not an inventory count or purchasability guarantee. " +
      "No cart, no auth.",
    inputSchema: {
      type: "object",
      properties: {
        url_key: { type: "string", minLength: 1, maxLength: 200, description: "exact product url_key (slug): [A-Za-z0-9._-] only, no slash, query/fragment or control characters" },
        expected_sku: { type: "string", minLength: 1, maxLength: 64, description: "exact SKU taken from the SAME search page/store as url_key; required to accept a canonical slug that differs from the search-issued one; a non-matching SKU is SKU_MISMATCH" },
      },
      required: ["url_key"],
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
  // Guest view of exactly one configured store: no default, no fallback, no auth.
  function guestStore() {
    const storeCode = env.MM_STORE_CODE;
    if (typeof storeCode !== "string" || storeCode === "") throw new CatalogError("MISSING_STORE_ENV", "MM_STORE_CODE is required, no default");
    if (!STORE_RE.test(storeCode)) throw new CatalogError("INVALID_STORE_CODE");
    return storeCode;
  }

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
    const storeCode = guestStore();

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
      if (!Number.isFinite(it.mm_qty_step) || it.mm_qty_step <= 0) throw new CatalogError("BAD_UPSTREAM_DATA", "card item mm_qty_step");
      if (typeof it.stock_status !== "string" || it.stock_status === "") throw new CatalogError("BAD_UPSTREAM_DATA", "card item stock_status");
      // slug is kept as-is (validated, never invented): it is what mm_get_product needs for
      // this same store, and a search card without a usable slug owes the caller no detail link
      if (typeof it.url_key !== "string" || !URL_KEY_RE.test(it.url_key)) throw new CatalogError("BAD_UPSTREAM_DATA", "card item url_key");
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
        url_key: it.url_key, // resolves detail in this store via mm_get_product
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

  // Exact detail for one url_key: captured ProductPage contract (exact filter,
  // show_disabled:true). Zero matches -> PRODUCT_NOT_FOUND, more than one -> fail closed.
  // Identity: with expected_sku the SKU binds the product (a different-but-valid canonical
  // slug is then acceptable, and the projected slug is the upstream one); without it the
  // returned slug must equal the requested one. Guest store: nothing here is a payable-price,
  // stock-count or purchasability claim.
  function validateDetailArgs(raw) {
    if (!isObj(raw)) throw new CatalogError("INVALID_ARGS", "arguments must be an object");
    const unknown = Object.keys(raw).filter((k) => !["url_key", "expected_sku"].includes(k));
    if (unknown.length) throw new CatalogError("INVALID_ARGS", `unknown argument(s): ${unknown.join(", ")}`);
    const urlKey = raw.url_key;
    if (typeof urlKey !== "string" || !URL_KEY_RE.test(urlKey)) {
      throw new CatalogError("INVALID_ARGS", "url_key must be a 1-200 char slug ([A-Za-z0-9._-]), no slash/query/control characters");
    }
    let expectedSku = null;
    if ("expected_sku" in raw) {
      const s = raw.expected_sku;
      if (typeof s !== "string" || s.length < 1 || s.length > SKU_MAX || hasControl(s)) {
        throw new CatalogError("INVALID_ARGS", `expected_sku must be a 1-${SKU_MAX} char string without control characters`);
      }
      expectedSku = s;
    }
    return { urlKey, expectedSku };
  }

  async function productDetail(rawArgs) {
    const { urlKey, expectedSku } = validateDetailArgs(rawArgs);
    const storeCode = guestStore();
    const data = await gql(DETAIL_QUERY, { urlKey }, storeCode); // JSON variables only, never interpolated
    const products = data.products;
    if (!isObj(products) || !Array.isArray(products.items)) throw new CatalogError("BAD_UPSTREAM_DATA", "products.items");
    if (products.items.length === 0) throw new CatalogError("PRODUCT_NOT_FOUND", `no product for url_key ${urlKey}`);
    if (products.items.length > 1) throw new CatalogError("MULTIPLE_PRODUCTS", `${products.items.length} products for one exact url_key`);
    const it = products.items[0];
    if (!isObj(it)) throw new CatalogError("BAD_UPSTREAM_DATA", "product item");
    if (typeof it.sku !== "string" || it.sku === "") throw new CatalogError("BAD_UPSTREAM_DATA", "product sku");
    // Identity: expected_sku is the only thing that can open an alias answer.
    if (expectedSku !== null) {
      if (it.sku !== expectedSku) throw new CatalogError("SKU_MISMATCH", `${it.sku} != ${expectedSku}`);
    } else if (it.url_key !== urlKey) {
      throw new CatalogError("PRODUCT_NOT_FOUND", "returned url_key is not the requested one");
    }
    if (!isInt(it.id, 0, Number.MAX_SAFE_INTEGER)) throw new CatalogError("BAD_UPSTREAM_DATA", "product id");
    // The slug the caller gets back must be a usable slug in this store, in every branch.
    if (typeof it.url_key !== "string" || !URL_KEY_RE.test(it.url_key)) {
      throw new CatalogError("BAD_UPSTREAM_DATA", "product url_key");
    }
    if (typeof it.name !== "string" || it.name === "") throw new CatalogError("BAD_UPSTREAM_DATA", "product name");
    if (typeof it.unit_ecom !== "string" || it.unit_ecom === "") throw new CatalogError("BAD_UPSTREAM_DATA", "product unit_ecom");
    if (!Number.isFinite(it.mm_qty_step) || it.mm_qty_step <= 0) throw new CatalogError("BAD_UPSTREAM_DATA", "product mm_qty_step");
    if (typeof it.stock_status !== "string" || it.stock_status === "") throw new CatalogError("BAD_UPSTREAM_DATA", "product stock_status");
    const reg = isObj(it.price) && isObj(it.price.regularPrice) ? it.price.regularPrice.amount : null;
    const mp = isObj(it.price_range) ? it.price_range.maximum_price : null;
    const fin = isObj(mp) ? mp.final_price : null;
    if (!moneyOk(reg) || !moneyOk(fin)) throw new CatalogError("PRICE_INVALID", `${it.sku} malformed price`);
    if (fin.value > reg.value) throw new CatalogError("PRICE_INVALID", `${it.sku} final above regular`);
    return {
      product: {
        id: it.id,
        sku: it.sku,
        name: it.name,
        url_key: it.url_key,
        unit: it.unit_ecom,
        quantity_step: it.mm_qty_step,
        stock_status: it.stock_status,
        price_vnd: fin.value,
        regular_price_vnd: reg.value,
        promotion: Array.isArray(it.dnr_price) ? it.dnr_price : null, // raw tier offers, not payable
        member_offer: isObj(it.dnr_mcard) ? it.dnr_mcard : null, // raw MCard offer, guest never sees a payable member price
      },
      context: { store_code: storeCode, authenticated: false },
      price_status: PRICE_STATUS,
      observed_at: new Date().toISOString(),
    };
  }

  async function callTool(name, args) {
    try {
      let projection;
      if (name === "mm_search_products") projection = await search(args);
      else if (name === "mm_get_product") projection = await productDetail(args);
      else throw new CatalogError("UNKNOWN_TOOL", String(name));
      return { content: [{ type: "text", text: JSON.stringify(projection) }] };
    } catch (e) {
      // Fixed code only. A raw thrown message may hold upstream internals, bodies or
      // credential-looking content: never echoed, never logged. Unknown throws are exactly
      // "INTERNAL"; CatalogError details are hand-written, nonsecret and stay.
      if (!(e instanceof CatalogError)) return { content: [{ type: "text", text: "INTERNAL" }], isError: true };
      return { content: [{ type: "text", text: e.detail ? `${e.code}: ${e.detail}` : e.code }], isError: true };
    }
  }

  return { callTool };
}
