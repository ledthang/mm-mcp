// Cart WRITE adapter: three owner-bound write tools, exactly ONE mutation per dispatched call.
//
// STATUS 2026-11-01 — read this before trusting anything below:
//   IMPLEMENTED + TESTED OFFLINE WITH FAKES. NOT LIVE-VERIFIED. No cart write has ever been
//   sent to https://online.mmvietnam.com from this repository (scripts/cart.test.mjs answers
//   from a fake transport; scripts/cart-live.mjs is the operator runner and currently reports
//   `blocked` because no live credential/approval is present). Every write needs an explicit
//   `confirm: true`; a dispatch whose effect is not confirmed by a fresh post-read is reported
//   `unknown` and NEVER retried here.
//
// Owner binding: the tools accept NO cart id. The cart is resolved internally from the
// authenticated owner lookup (`customerCart`, evidenced by C45 `GetCustomerCartAddress`
// [7303,7463) / A `ShippingInformationFragment` [6371,7324) in
// docs/cart-write-contract.md) and injected into the `$cartId`-parameterised documents as
// `$cartId` / `cart_id`. A caller-supplied cart id is refused (`INVALID_ARGS`), never
// forwarded and never silently ignored. The resolved id is never emitted in a report.
//
// UNVERIFIED semantics, kept labelled rather than assumed (docs/cart-write-contract.md
// "Remaining gates", all still OPEN):
//   * add merge-vs-new-line            * update quantity absolute-vs-delta
//   * quantity step / min / max (`mm_qty_step`, `unit_ecom`, `mis_stock`)
//   * address binding (blocked: `customer_address_id`/`city_code`/`ward_code` missing)
//   * `CartItemInput` / `CartItemUpdateInput` internals; POST vs GET transport for mutations
// No default step is invented, no constraint is assumed, no price is recomputed.
//
// Exactly one mutation per invocation: no retry middleware, no cleanup/compensating
// mutation, no create/merge/clear-cart, no checkout, no order, no address or delivery-date
// write. The in-process intent guard below prevents LOCAL duplicate dispatch only — it is
// not backend exactly-once and cannot exclude a browser or another client.

import crypto from "node:crypto";
import { createAccount } from "./account.mjs";

const GRAPHQL_URL = "https://online.mmvietnam.com/graphql"; // same single origin as the other modules
const POST_TIMEOUT_MS = 25000; // one request, one deadline (same ceiling as catalog/account)
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_INTENTS = 64; // guard holds the last 64 intents in this process (ceiling, documented)

// ------------------------------------------------------------------ wire documents
// Copied verbatim from docs/cart-write-contract.md. Evidence in the comments above each one:
// record numbers and the zero-based byte offsets printed in that document.

// Owner/cart snapshot — the ONLY read this adapter makes, used as both pre-read and
// post-read so the two are directly comparable. `customerCart { id ... }` is evidenced by
// C45 `GetCustomerCartAddress` [7303,7463) (and A `ShippingInformationFragment`
// [6371,7324)); the item/price selections are the ones already shipped in
// src/account.mjs CART_QUERY (proven HTTP 200 per that file's header) plus `id`, so this is
// a widening of an existing live-proven projection by exactly one evidenced field, not an
// invention. No cart id comes from the caller anywhere in this flow.
//
// FIXED 2026-11-01: the shipped string was missing the closing brace of `customerCart`
// (depth 1 at end of text) => every POST answered HTTP 400 "Syntax Error: Expected Name,
// found <EOF>", so the pre-read failed and NO mutation was ever dispatched. One `}` added
// at the end — nothing else. Proof: scripts/cart-parse-proof.mjs (anonymous, read-only,
// exact bytes shipped here) reports whether upstream PARSES this document; the structural
// balance check in scripts/cart.test.mjs is the offline regression that catches the class.
export const CART_SNAPSHOT_QUERY =
  "query MMCartSnapshot{customerCart{id total_quantity items{uid quantity product{sku name} prices{price{currency value}row_total{currency value}}}prices{grand_total{currency value}}}}";

// Add — signature `AddItemToCart($cartId: String!, $cartItem: CartItemInput!)` verbatim from
// records #2 / #4 / #6 (U1 offset 269925, U2 315263, U3 461385); `addProductsToCart(cartId:
// $cartId, cartItems: [$cartItem])` is the app-single call site (backend arg is always the
// list). Response selection copied from the bulk records #1 / #3 / #5 (U1 268102, U2 313440,
// U3 459562), which the contract records as "identical response, one-element list".
// merge-vs-new-line: UNVERIFIED. `CartItemInput` internals: only {sku, quantity} is sent,
// and that pair is unevidenced too (the documents show the type name only).
export const ADD_DOC = `mutation AddItemToCart($cartId: String!, $cartItem: CartItemInput!) {
  addProductsToCart(cartId: $cartId, cartItems: [$cartItem]) {
    cart {
      id
      prices {
        discounts { amount { currency value } label }
        grand_total { currency value }
        subtotal_excluding_tax { currency value }
        subtotal_including_tax { currency value }
        subtotal_with_discount_excluding_tax { currency value }
      }
      total_quantity
      items {
        uid product { id uid }
        prices { price { currency value } row_total { currency value } total_item_discount { value } }
        quantity
      }
    }
    user_errors { code message }
  }
}`;

// Update — records #8 / #10 / #12 (U1 offset 255888, U2 308127, U3 380322), identical after
// normalisation; line addressed by `cart_item_uid`, `cart_item_id` appears in no record. The
// list variant (`$cartItems: [CartItemUpdateInput!]!`, records #9/#11/#13) is NOT used: its
// member field names are unevidenced. The four fragment definitions are supplied verbatim
// from A ([617526,617845), [436891,437073), [695259,695461), [818917,819052)) because a
// spread with no definition is not a standalone request. Absolute-vs-delta quantity:
// UNVERIFIED — `$quantity` is passed through unchanged and whatever happens is reported.
export const UPDATE_DOC = `mutation updateItemInCart($cartId: String!, $itemId: ID!, $quantity: Float!) {
  updateCartItems(input: { cart_id: $cartId, cart_items: [{ cart_item_uid: $itemId, quantity: $quantity }] }) {
    cart {
      id total_quantity
      # If this mutation causes "free" to become available we need to know.
      available_payment_methods { code title }
      items {
        uid
        prices { total_item_discount { value } row_total { value } }
        product { id uid }
        prices { price { currency value } row_total { value } total_item_discount { value } }
        quantity errors { code message }
      }
      # eslint-disable-next-line @graphql-eslint/require-id-when-available
      ...ShippingSummaryFragment
      prices {
        ...TaxSummaryFragment ...DiscountSummaryFragment ...GrandTotalFragment
        subtotal_excluding_tax { currency value }
        subtotal_including_tax { currency value }
        totals_tax { value currency }
      }
    }
  }
}

fragment ShippingSummaryFragment on Cart { id shipping_addresses { selected_shipping_method { amount { currency value } method_title } street } }
fragment TaxSummaryFragment on CartPrices { applied_taxes { amount { currency value } } }
fragment DiscountSummaryFragment on CartPrices { discounts { amount { currency value } label } }
fragment GrandTotalFragment on CartPrices { grand_total { currency value } }`;

// Remove — `RemoveItemForMiniCart` verbatim from A [792289, 794463), repeated `prices`
// selections retained as printed. Response mirrors updateItemInCart; per-line `errors` are
// read from it. Wire document evidenced, backend behaviour untested.
export const REMOVE_DOC = `mutation RemoveItemForMiniCart($cartId: String!, $itemId: ID!) {
  removeItemFromCart(input: { cart_id: $cartId, cart_item_uid: $itemId }) {
    cart {
      id total_quantity available_payment_methods { code title }
      items {
        uid
        prices { total_item_discount { value } row_total { value } }
        product { id uid }
        prices { price { currency value } row_total { value } total_item_discount { value } }
        quantity errors { code message }
      }
      ...ShippingSummaryFragment
      prices {
        ...TaxSummaryFragment ...DiscountSummaryFragment ...GrandTotalFragment
        subtotal_excluding_tax { currency value }
        subtotal_including_tax { currency value }
        totals_tax { value currency }
      }
    }
  }
}

fragment ShippingSummaryFragment on Cart { id shipping_addresses { selected_shipping_method { amount { currency value } method_title } street } }
fragment TaxSummaryFragment on CartPrices { applied_taxes { amount { currency value } } }
fragment DiscountSummaryFragment on CartPrices { discounts { amount { currency value } label } }
fragment GrandTotalFragment on CartPrices { grand_total { currency value } }`;

export const TOOLS = [
  {
    name: "mm_add_to_cart",
    description:
      "Add ONE product line to the authenticated owner's cart (WRITE — implemented and " +
      "offline-tested with fakes, NOT live-verified). Owner-bound: there is NO cart id " +
      "argument, the cart is resolved from the authenticated session and a cart_id/cartId " +
      "argument is refused. Requires confirm: true, otherwise nothing is dispatched and the " +
      "exact current pre-state is returned so you can confirm against it. Sequence: fresh " +
      "owner-bound pre-read -> validate -> exactly ONE addProductsToCart mutation (cartItems: " +
      "[{sku, quantity}]) -> fresh owner-bound post-read -> report observed state. Verdict is " +
      "one of applied | rejected | unknown; 'unknown' means the mutation may already have " +
      "applied — re-read with mm_get_cart, this tool never auto-retries. Add merge-vs-new-line " +
      "is UNVERIFIED: quantity 2 on a sku you already hold may merge into that line or create " +
      "a new one — the post-read report says which was observed. Quantities may be fractional " +
      "(1.5, 2.25) and are passed through exactly; step/min/max (mm_qty_step, unit_ecom, " +
      "mis_stock) are UNVERIFIED and not enforced here, so an out-of-stock or step-violating " +
      "add is reported by the backend errors, never predicted. line_count and total_quantity " +
      "are reported separately: a line count is never a quantity. HTTP 200 or a completed " +
      "mutation is never success on its own.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "exact SKU to add (non-empty)" },
        quantity: { type: "number", description: "finite number > 0; fractional allowed (sold by weight); 0 is refused — use mm_remove_cart_item" },
        confirm: { type: "boolean", description: "must be true or nothing is dispatched" },
      },
      required: ["sku", "quantity", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "mm_update_cart_item",
    description:
      "Change the quantity of ONE existing cart line (WRITE — implemented and offline-tested " +
      "with fakes, NOT live-verified). Addressed by the line uid from mm_get_cart, never by " +
      "index; there is NO cart id argument (owner-bound, cart_id refused). Requires " +
      "confirm: true, otherwise nothing is dispatched and the exact pre-state is returned. " +
      "Sequence: fresh pre-read -> validate the uid exists -> exactly ONE updateCartItems " +
      "mutation (cart_items: [{cart_item_uid, quantity}]) -> fresh post-read -> report observed " +
      "state. Absolute-vs-delta is UNVERIFIED: your quantity is passed through unchanged, and " +
      "the report says which interpretation the observed state matches. quantity 0 is refused " +
      "(explicit remove required: mm_remove_cart_item). Per-line errors from the wire are " +
      "returned verbatim and never dressed up as success; a completed mutation is not success. " +
      "Verdict applied | rejected | unknown; unknown means it may already have applied — " +
      "re-read, never auto-retry.",
    inputSchema: {
      type: "object",
      properties: {
        item_uid: { type: "string", description: "exact cart line uid from mm_get_cart (non-empty); must exist in the pre-read cart" },
        quantity: { type: "number", description: "finite number > 0, passed through unchanged; fractional preserved exactly; 0 refused" },
        confirm: { type: "boolean", description: "must be true or nothing is dispatched" },
      },
      required: ["item_uid", "quantity", "confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "mm_remove_cart_item",
    description:
      "Remove ONE existing cart line (WRITE — implemented and offline-tested with fakes, NOT " +
      "live-verified). Addressed by the line uid from mm_get_cart, never by index; there is " +
      "NO cart id argument (owner-bound, cart_id refused) and no quantity argument. Requires " +
      "confirm: true, otherwise nothing is dispatched and the exact pre-state is returned. " +
      "Sequence: fresh pre-read -> validate the uid exists -> exactly ONE removeItemFromCart " +
      "mutation -> fresh post-read -> report observed state. A post-read without the uid is " +
      "consistent with the removal; this adapter cannot prove this request caused it (another " +
      "client may have removed it). Verdict applied | rejected | unknown; unknown means the " +
      "removal may already have happened — re-read, never auto-retry. This tool never clears " +
      "the whole cart and never removes more than the one line named.",
    inputSchema: {
      type: "object",
      properties: {
        item_uid: { type: "string", description: "exact cart line uid from mm_get_cart (non-empty); must exist in the pre-read cart" },
        confirm: { type: "boolean", description: "must be true or nothing is dispatched" },
      },
      required: ["item_uid", "confirm"],
      additionalProperties: false,
    },
  },
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmpty = (v) => typeof v === "string" && v.length > 0;
const isQty = (v) => typeof v === "number" && Number.isFinite(v) && v > 0; // fractional allowed, never truncated
const moneyOk = (m, currency) =>
  isObj(m) && m.currency === currency && typeof m.value === "number" && Number.isFinite(m.value) && m.value >= 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One fixed code per failure; upstream bodies, raw thrown messages and the credential never
// appear in a detail.
class CartError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export function createCart({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  // Credential loading is REUSED from src/account.mjs (same path resolution, same strict
  // file/parent validation, same REQUIRES_LOGIN discipline) — no second implementation of it
  // here. The transport is this module's own POST, because a mutation must not be sent as a
  // GET; POST-for-query is used for the snapshot reads too, so there is exactly one
  // transport in this adapter (method is convention, unverified against this endpoint).
  const acct = createAccount({ fetchImpl, env });
  // In-process intent guard: prevents LOCAL duplicate dispatch of an identical intent.
  // Not backend exactly-once: a restart clears it, and a browser can still double-add.
  // A key is either IN FLIGHT (dispatch in progress, or being validated right now) or
  // TERMINAL (a report a later duplicate is answered from).
  // Identity binding: the key holds a one-way DIGEST of the credential (never the token,
  // never a prefix of it), so a report earned under one credential can never be handed back
  // as another credential's answer — not on rotation, not under a second account sharing the
  // same store code.
  const intents = new Map(); // insertion-ordered: oldest first, and in-flight is never evicted

  // the credential digest is computed once per call and only ever joins the key as hex
  // (the FULL sha256: no truncation to decide about, and the key is in-process only)
  const guardKey = (name, auth, intent) =>
    `${name}\u0000${crypto.createHash("sha256").update(`${auth.store}\u0000${auth.authorization}`, "utf8").digest("hex")}` +
    `\u0000${Object.keys(intent).sort().map((k) => `${k}=${String(intent[k])}`).join(",")}`; // canonical; pre_quantity is NOT part of intent when this is called

  // claim(): takes the slot BEFORE any await that could lead to a dispatch, so two
  // concurrent identical calls cannot both reach the mutation. true = we own the slot;
  // "duplicate" = an identical intent is in flight or already answered (answer from it,
  // zero requests); "full" = every slot is in flight, so fail closed without dispatching.
  // Nothing is evicted while in flight (that is what stops the double dispatch), and the
  // map is capped at MAX_INTENTS, so it cannot grow without bound.
  function claim(key) {
    if (intents.has(key)) return "duplicate";
    if (intents.size >= MAX_INTENTS) {
      for (const [k, v] of intents) { if (!v.inFlight) { intents.delete(k); break; } } // oldest TERMINAL first
      if (intents.size >= MAX_INTENTS) return "full"; // every slot in flight: no dispatch, no eviction
    }
    intents.set(key, { inFlight: true });
    return true;
  }
  // settle(): in-flight => terminal, same slot (so eviction order stays truthful).
  function settle(key, report) { if (intents.has(key)) intents.set(key, { inFlight: false, report }); }
  // releaseGuard(): nothing was ever dispatched by the holder (bad arg, credential problem,
  // pre-read failed). The claim must not linger, or a later honest retry of an intent that
  // never reached the backend would be answered "already dispatched" forever.
  function releaseGuard(key) { intents.delete(key); }

  // ---------------------------------------------------------------- one gql POST
  // { Authorization, store } headers only (the pair src/account.mjs already uses); a
  // credential problem is REQUIRES_LOGIN and is detected locally before any request.
  // Every transport/status/size/JSON/GraphQL failure is exactly one fixed code, and the
  // response stream is always released before throwing.
  async function gql(auth, query, variables = {}) {
    let res;
    try {
      res = await fetchImpl(GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: auth.authorization, store: auth.store },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (e) {
      const name = e && typeof e === "object" ? e.name : undefined;
      if (name === "TimeoutError" || name === "AbortError") throw new CartError("UPSTREAM_TIMEOUT");
      throw new CartError("UPSTREAM_UNREACHABLE");
    }
    const release = async () => { if (res.body) { try { await res.body.cancel(); } catch { /* closed */ } } };
    if (!res.ok) {
      await release();
      if (res.status === 401 || res.status === 403) throw new CartError("REQUIRES_LOGIN", `HTTP ${res.status} credential rejected`);
      throw new CartError("UPSTREAM_HTTP_STATUS", `HTTP ${res.status}`);
    }
    const cl = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      await release();
      throw new CartError("RESPONSE_TOO_LARGE");
    }
    if (!res.body) throw new CartError("RESPONSE_NOT_JSON", "no response body");
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
        if (name === "TimeoutError" || name === "AbortError") throw new CartError("UPSTREAM_TIMEOUT");
        throw new CartError("UPSTREAM_UNREACHABLE");
      }
      if (r.done) break;
      size += r.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* closed */ }
        throw new CartError("RESPONSE_TOO_LARGE");
      }
      parts.push(Buffer.from(r.value));
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new CartError("RESPONSE_NOT_JSON");
    }
    if (!isObj(payload)) throw new CartError("RESPONSE_NOT_JSON");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const authErrors = payload.errors.filter(
        (e) => isObj(e) && (
          (Array.isArray(e.categories) && e.categories.some((c) => typeof c === "string" && c.toUpperCase() === "AUTHENTICATION")) ||
          (isObj(e.extensions) && e.extensions.code === "UNAUTHENTICATED")),
      ).length;
      if (authErrors > 0) throw new CartError("REQUIRES_LOGIN", `${authErrors} authentication error(s)`);
      throw new CartError("GRAPHQL_ERRORS", `${payload.errors.length} error(s)`);
    }
    if (!isObj(payload.data)) throw new CartError("RESPONSE_NOT_JSON", "no data object");
    return payload.data;
  }

  // ------------------------------------------------------- snapshot projection (reads)
  // Owner-bound: everything comes from customerCart. Counts and totals are copied, never
  // recomputed: line_count is rows counted here, total_quantity is upstream's own field —
  // the two are distinct facts and are never interchanged.
  function projectSnapshot(data) {
    const cart = data.customerCart;
    if (cart === null || cart === undefined) throw new CartError("REQUIRES_LOGIN", "HTTP 200 but no customerCart: not authenticated");
    if (!isObj(cart) || !["id", "total_quantity", "items", "prices"].every((k) => k in cart)) {
      throw new CartError("BAD_UPSTREAM_DATA", "customerCart");
    }
    if (!isNonEmpty(cart.id)) throw new CartError("BAD_UPSTREAM_DATA", "customerCart.id");
    const tq = cart.total_quantity;
    if (typeof tq !== "number" || !Number.isFinite(tq) || tq < 0) throw new CartError("BAD_UPSTREAM_DATA", "total_quantity");
    if (!Array.isArray(cart.items)) throw new CartError("BAD_UPSTREAM_DATA", "items");
    const lines = [];
    for (const it of cart.items) {
      if (
        !isObj(it) ||
        !["uid", "quantity", "product", "prices"].every((k) => k in it) ||
        !isNonEmpty(it.uid) ||
        !isObj(it.product) || !isNonEmpty(it.product.sku) || !isNonEmpty(it.product.name) ||
        !isObj(it.prices)
      ) {
        throw new CartError("BAD_UPSTREAM_DATA", "cart line");
      }
      if (!isQty(it.quantity)) throw new CartError("BAD_UPSTREAM_DATA", "cart line quantity");
      if (lines.some((r) => r.uid === it.uid)) throw new CartError("BAD_UPSTREAM_DATA", "duplicate cart line uid");
      lines.push({
        uid: it.uid,
        sku: it.product.sku,
        name: it.product.name,
        quantity: it.quantity,
        price_vnd: moneyOk(it.prices.price, "VND") ? it.prices.price.value : (() => { throw new CartError("BAD_MONEY", "cart line price"); })(),
        row_total_vnd: moneyOk(it.prices.row_total, "VND") ? it.prices.row_total.value : (() => { throw new CartError("BAD_MONEY", "cart line row_total"); })(),
      });
    }
    if (!isObj(cart.prices)) throw new CartError("BAD_UPSTREAM_DATA", "prices");
    return {
      id: cart.id, // internal only: never emitted to the caller, used to compare pre/post
      observed_at: new Date().toISOString(),
      line_count: lines.length, // rows counted here — NOT a quantity
      total_quantity: tq, // upstream's own figure — NOT a line count
      lines,
      grand_total_vnd: moneyOk(cart.prices.grand_total, "VND") ? cart.prices.grand_total.value : (() => { throw new CartError("BAD_MONEY", "cart grand_total"); })(),
    };
  }

  const summarize = (s) => ({ // safe, compact form for a report (rows + counts, no ids of carts)
    observed_at: s.observed_at,
    line_count: s.line_count,
    total_quantity: s.total_quantity,
    grand_total_vnd: s.grand_total_vnd,
    lines: s.lines,
  });

  async function readSnapshot(auth, stage) {
    const data = await gql(auth, CART_SNAPSHOT_QUERY, {}); // REQUIRES_LOGIN / transport codes, no raw body
    const s = projectSnapshot(data); // throws BAD_UPSTREAM_DATA / REQUIRES_LOGIN / BAD_MONEY
    return { stage, id: s.id, summary: summarize(s) };
  }

  // ------------------------------------------------------------------- one mutation
  async function dispatchMutation(auth, docName, doc, variables) {
    const data = await gql(auth, doc, variables); // ONE request: the guard around it is the caller's
    const root = data[docName];
    if (!isObj(root)) throw new CartError("BAD_UPSTREAM_DATA", `no ${docName} object in data`);
    return root;
  }

  // Collect verbatim error entries from a mutation response: `user_errors` (add) and
  // per-line `errors` (update / remove). Never paraphrased, never treated as success.
  function collectErrors(docName, root) {
    const out = [];
    const push = (where, list) => {
      if (!Array.isArray(list)) return;
      for (const e of list) {
        if (!isObj(e)) continue;
        const code = isNonEmpty(e.code) ? e.code : "UNKNOWN";
        const message = isNonEmpty(e.message) ? e.message : "";
        if (message === "" && code === "UNKNOWN") continue;
        out.push({ where, code, message });
      }
    };
    if (docName === "addProductsToCart") push("user_errors", root.user_errors);
    const cart = isObj(root.cart) ? root.cart : null;
    if (cart && Array.isArray(cart.items)) {
      for (const it of cart.items) {
        if (!isObj(it)) continue;
        push(`line ${isNonEmpty(it.uid) ? it.uid : "?"}`, it.errors);
      }
    }
    return out;
  }

  // Observed-state checks: what a successful intent must look like in the post-read.
  // Each returns { ok, observed } — `ok` means the post-read is consistent with the intent;
  // causality is still not provable (another client could have done it), and that caveat is
  // carried in the report text, not assumed away.
  // add merge-vs-new-line: compare the PRE snapshot (does the sku already sit in a line?)
  // against the POST snapshot. Both are owner-bound reads; causality is still not provable
  // (another client may have added the same sku), which the report states.
  function checkAdd(pre, post, intent) {
    const preHas = pre.lines.some((l) => l.sku === intent.sku);
    const postRows = post.lines.filter((l) => l.sku === intent.sku);
    if (postRows.length === 0) return { ok: false, layout: "not_in_cart", quantity_observed: null };
    const layout = preHas ? "same_or_merged (pre already had the sku)" : "new_line (sku absent from pre)";
    const q = postRows.length === 1 ? postRows[0].quantity : postRows.map((r) => r.quantity);
    return { ok: true, layout, quantity_observed: q };
  }

  async function callTool(name, args) {
    const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
    const fail = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }], isError: true });
    let held = null; // the guard key this invocation claimed; set before any dispatch can happen
    try {
      // ---- 1. arguments: strict, and no request is made for a bad argument
      if (!TOOLS.some((t) => t.name === name)) throw new CartError("UNKNOWN_TOOL", String(name));
      if (!isObj(args)) throw new CartError("INVALID_ARGS", "arguments must be an object");
      const allowed = name === "mm_add_to_cart" ? ["sku", "quantity", "confirm"]
        : name === "mm_update_cart_item" ? ["item_uid", "quantity", "confirm"]
          : ["item_uid", "confirm"];
      const cartIdKeys = Object.keys(args).filter((k) => /^(cart_?id|cart_?uid|cartItem_?id|cart_item_id)$/i.test(k));
      if (cartIdKeys.length) {
        throw new CartError("INVALID_ARGS", `${cartIdKeys.join(", ")}: no cart id is accepted here — the cart is resolved from the authenticated session (owner-bound), a caller cart id is refused, not forwarded`);
      }
      const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new CartError("INVALID_ARGS", `unknown argument(s): ${unknown.join(", ")}`);

      const intent = {};
      if (name === "mm_add_to_cart") {
        if (!isNonEmpty(args.sku)) throw new CartError("INVALID_ARGS", "sku must be a non-empty string");
        if (!("quantity" in args)) throw new CartError("INVALID_ARGS", "quantity is required");
        if (!isQty(args.quantity)) {
          throw new CartError("INVALID_ARGS", args.quantity === 0
            ? "quantity 0 is not an implicit remove — use mm_remove_cart_item with confirm: true"
            : "quantity must be a finite number greater than 0 (fractional allowed, e.g. 1.5; NaN/Infinity/negative/non-number refused)");
        }
        intent.sku = args.sku;
        intent.quantity = args.quantity;
      } else {
        if (!isNonEmpty(args.item_uid)) throw new CartError("INVALID_ARGS", "item_uid must be a non-empty string (the exact line uid from mm_get_cart, never an index)");
        intent.item_uid = args.item_uid;
        if (name === "mm_update_cart_item") {
          if (!("quantity" in args)) throw new CartError("INVALID_ARGS", "quantity is required");
          if (!isQty(args.quantity)) {
            throw new CartError("INVALID_ARGS", args.quantity === 0
              ? "quantity 0 is not an implicit remove — use mm_remove_cart_item with confirm: true"
              : "quantity must be a finite number greater than 0 (fractional allowed and preserved exactly)");
          }
          intent.quantity = args.quantity;
        }
      }
      if (!("confirm" in args)) {
        throw new CartError("CONFIRM_REQUIRED", "no mutation dispatched: pass confirm: true to change the cart, or read it with mm_get_cart");
      }
      if (args.confirm !== true) {
        throw new CartError("NOT_CONFIRMED", `no mutation dispatched: confirm was ${JSON.stringify(args.confirm)} — it must be exactly true`);
      }

      // ---- 2. credential (reused loader from src/account.mjs): a local problem is
      // REQUIRES_LOGIN with zero requests made.
      const auth = await acct.loadAuth();

      // ---- 3. intent guard: claim the slot HERE, before the pre-read await and before any
      // dispatch. Two concurrent identical calls therefore cannot both reach the mutation:
      // the loser sees the in-flight claim and answers with zero requests. A repeat of an
      // already-answered intent is answered from the recorded report, also zero requests.
      // Local duplicate-dispatch protection only — not backend exactly-once.
      const key = guardKey(name, auth, intent); // credential digest inside; the token never is
      const claimState = claim(key);
      if (claimState === true) held = key; // we own the slot from here: nothing is dispatched before it
      if (claimState === "full") {
        // every guard slot is in flight: dispatch nothing rather than risk an unguarded duplicate
        return fail({
          tool: name, verdict: "rejected", mutation_count: 0, dispatched: false, code: "GUARD_FULL",
          intent, cart_id: "not exposed (owner-bound, resolved internally)",
          next_step: `all ${MAX_INTENTS} intent-guard slots are in flight (local cap, in-process only) — re-read with mm_get_cart, then retry`,
        });
      }
      if (claimState === "duplicate") {
        const prior = intents.get(key);
        if (prior.inFlight) {
          // an identical intent is being handled right now: do NOT dispatch a second copy and
          // do not wait for it — its outcome is not this call's to invent
          return fail({
            tool: name, verdict: "unknown", mutation_count: 0, dispatched: false, duplicate_intent: true,
            code: "INTENT_IN_FLIGHT",
            intent, cart_id: "not exposed (owner-bound, resolved internally)",
            next_step: "an identical write is already in flight from this process — re-read with mm_get_cart to see whether it landed; this call dispatched nothing and will not wait",
          });
        }
        return fail({
          tool: name,
          verdict: prior.report.verdict,
          mutation_count: 0,
          duplicate_intent: true,
          intent,
          note: "duplicate intent: this exact write was already dispatched in this process and answered " + prior.report.verdict +
            " (guard hit, zero new requests, never auto-retried). The state shown was observed then, not now. " +
            "Local duplicate-dispatch protection only — it is not backend exactly-once.",
          prior: prior.report,
          cart_id: "not exposed (owner-bound, resolved internally)",
          next_step: "re-read with mm_get_cart for a fresh view",
        });
      }

      // ---- 4. PRE-READ: fresh, owner-bound. This is also the exact pre-state a refusal names.
      const pre = await readSnapshot(auth, "pre");

      // ---- 5. validate against the pre-read, then dispatch EXACTLY ONE mutation
      if (name !== "mm_add_to_cart") {
        const target = pre.summary.lines.find((l) => l.uid === intent.item_uid);
        if (!target) {
          throw new CartError("NOT_IN_CART", `no cart line with uid ${intent.item_uid} in the current cart — nothing dispatched; current cart: ${pre.summary.line_count} line(s), total_quantity ${pre.summary.total_quantity}`);
        }
        if (name === "mm_update_cart_item") intent.pre_quantity = target.quantity;
      }
      const docName = name === "mm_add_to_cart" ? "addProductsToCart" : name === "mm_update_cart_item" ? "updateCartItems" : "removeItemFromCart";
      const doc = name === "mm_add_to_cart" ? ADD_DOC : name === "mm_update_cart_item" ? UPDATE_DOC : REMOVE_DOC;
      const variables = name === "mm_add_to_cart"
        ? { cartId: pre.id, cartItem: { sku: intent.sku, quantity: intent.quantity } }
        : name === "mm_update_cart_item"
          ? { cartId: pre.id, itemId: intent.item_uid, quantity: intent.quantity }
          : { cartId: pre.id, itemId: intent.item_uid };

      let root;
      let errors = [];
      try {
        root = await dispatchMutation(auth, docName, doc, variables); // exactly one mutation
        errors = collectErrors(docName, root);
      } catch (e) {
        // Dispatch outcome is indeterminate: the write MAY already have applied. Never retry.
        const code = e instanceof CartError ? e.code : "INTERNAL";
        const report = {
          tool: name,
          verdict: "unknown",
          mutation_count: 1, // dispatched once; whether it applied is not known
          duplicate_intent: false,
          intent,
          dispatch: { code, detail: e instanceof CartError && e.detail ? e.detail : "" },
          pre_state: pre.summary,
          post_state: null,
          cart_change_detected: null,
          errors,
          cart_id: "not exposed (owner-bound, resolved internally)",
          next_step: "the mutation may already have applied — re-read with mm_get_cart to see the current state; this tool never auto-retries, and a second dispatch would risk a double add",
        };
        settle(key, report);
        return fail(report);
      }

      // ---- 6. POST-READ: fresh, owner-bound, the authority for the verdict
      let post;
      try {
        post = await readSnapshot(auth, "post");
      } catch (e) {
        const report = {
          tool: name,
          verdict: "unknown",
          mutation_count: 1,
          duplicate_intent: false,
          intent,
          pre_state: pre.summary,
          post_state: null,
          post_read: { code: e instanceof CartError ? e.code : "INTERNAL", detail: e instanceof CartError && e.detail ? e.detail : "" },
          cart_change_detected: null,
          errors,
          cart_id: "not exposed (owner-bound, resolved internally)",
          next_step: "one mutation was dispatched and could not be observed afterwards — re-read with mm_get_cart; this tool never auto-retries",
        };
        settle(key, report);
        return fail(report);
      }

      // ---- 7. verdict from observed state, never from HTTP 200 or mutation completion
      // Compare DATA only: summary carries observed_at, so a raw compare would always differ.
      const cartChanged = !same({ lc: pre.summary.line_count, tq: pre.summary.total_quantity, gt: pre.summary.grand_total_vnd, ln: pre.summary.lines },
                                { lc: post.summary.line_count, tq: post.summary.total_quantity, gt: post.summary.grand_total_vnd, ln: post.summary.lines });
      if (pre.id !== post.id) {
        const report = {
          tool: name,
          verdict: "unknown",
          mutation_count: 1,
          duplicate_intent: false,
          intent,
          pre_state: pre.summary,
          post_state: post.summary,
          cart_change_detected: cartChanged,
          note: "the resolved cart changed between the pre-read and the post-read — attribution is not possible; never retarget",
          errors,
          cart_id: "not exposed (owner-bound, resolved internally)",
          next_step: "re-read with mm_get_cart; this tool never auto-retries",
        };
        settle(key, report);
        return fail(report);
      }

      let ok = false;
      let detail = {};
      if (name === "mm_add_to_cart") {
        const c = checkAdd(pre.summary, post.summary, intent);
        ok = c.ok && cartChanged && errors.length === 0;
        detail = { layout: c.layout, quantity_observed: c.quantity_observed, merge_vs_new_line: "UNVERIFIED (observed above, not predicted)" };
      } else if (name === "mm_update_cart_item") {
        const row = post.summary.lines.find((l) => l.uid === intent.item_uid);
        const q = row ? row.quantity : null;
        const abs = q !== null && q === intent.quantity;
        const delta = q !== null && intent.pre_quantity !== undefined && q === intent.pre_quantity + intent.quantity;
        ok = q !== null && (abs || delta) && cartChanged && errors.length === 0;
        detail = {
          quantity_requested: intent.quantity,
          quantity_pre: intent.pre_quantity ?? null,
          quantity_observed: q,
          matches_absolute: abs,
          matches_delta: delta,
          absolute_vs_delta: "UNVERIFIED — the value was passed through unchanged; which interpretation the observed state matches is reported above",
        };
      } else {
        const still = post.summary.lines.some((l) => l.uid === intent.item_uid);
        ok = !still && cartChanged && errors.length === 0;
        detail = { uid_present_post: still, note: "uid absent from the post-read is consistent with the removal; this cannot prove this request caused it" };
      }

      // applied   : the backend complained about nothing AND the cart moved as this call says.
      // rejected  : the backend errored AND the observed cart is unchanged — only then does
      //             an error corroborate a refusal. errors.length > 0 is NOT enough on its
      //             own: errors WITH a changed cart cannot prove this intent failed (a partial
      //             application — some units in, the rest refused — is a realistic answer),
      //             and a clean answer with an unchanged cart claims what was not observed.
      const corroboratedRejection = errors.length > 0 && !cartChanged;
      const verdict = ok ? "applied" : corroboratedRejection ? "rejected" : "unknown";
      const report = {
        tool: name,
        verdict,
        mutation_count: 1,
        dispatched: true,
        duplicate_intent: false,
        intent,
        ...detail,
        pre_state: pre.summary,
        post_state: post.summary,
        cart_change_detected: cartChanged,
        line_count_is_not_quantity: "line_count counts rows; total_quantity and per-line quantity are upstream figures — never interchanged",
        errors,
        cart_id: "not exposed (owner-bound, resolved internally)",
        price_status: "cart-observed-not-guaranteed-payable: totals copied from upstream, never recomputed here",
        next_step: verdict === "applied"
          ? "no retry issued; re-read with mm_get_cart whenever you need a fresh view"
          : verdict === "rejected"
            ? "the backend refused and the observed cart is unchanged — fix what errors names, then retry"
            : "the mutation may already have applied — re-read with mm_get_cart; this tool never auto-retries",
        observed_at: new Date().toISOString(),
      };
      settle(key, report);
      return verdict === "applied" ? text(report) : fail(report);
    } catch (e) {
      // Fixed code only — an upstream body, a raw thrown message or the credential never
      // appear here. The account loader throws AccountError (REQUIRES_LOGIN etc.); map its
      // code, never its message (which could name a path or hold the token). This catch is
      // reached ONLY while nothing had been dispatched (bad args / credential / pre-read /
      // pre-read validation) — every dispatched path returns its own report inside the try,
      // so the guard is settled there and never released here.
      const code = (e && typeof e.code === "string" && /^[A-Z0-9_]{1,48}$/.test(e.code)) ? e.code : "INTERNAL";
      const detail = e instanceof CartError && e.detail ? e.detail : ""; // own details only: an
      // AccountError message (which can name a path) is mapped to its code, never echoed.
      // Nothing was dispatched, so the claim is released: a later honest retry of an intent
      // that never reached the backend must not be answered "already dispatched" forever.
      if (held) releaseGuard(held);
      return fail({ tool: name, verdict: "rejected", mutation_count: 0, dispatched: false, code, detail, next_step: "nothing was dispatched — re-read with mm_get_cart, fix what is named, then retry" });
    }
  }

  // Credential loading is REUSED: createAccount returns { callTool, loadAuth } and loadAuth
  // is the same strict per-call loader account's tools use. No second implementation here;
  // the token itself is never logged or echoed by either path.
  return { callTool };
}
