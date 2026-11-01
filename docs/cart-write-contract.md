# Cart-write contract discovery — 2026-10-31 (rev 2)

**Verdict: SOURCE-VERIFIED, LIVE UNVERIFIED. No implementation and no live write authorized.**

Rev 1 of this document said add/update GraphQL documents were **missing**. That was wrong and is corrected here. The verified extractor output `/tmp/mm-cart-operations-<random>/mm-cart-operations.json` (a fresh private directory per run, dir mode `0700`, file mode `0600`; the old predictable path `/tmp/mm-cart-operations.json` is never written) (`scripts/cart_contract_extract.py`, run: `SELFCHECK OK`, `decode_failures: 0`) holds **13 records = 5 distinct operation texts** across 4 public chunks:

- **Add** — `AddProductToCart` (vendor, 1 record) and `AddItemToCart` (bulk + single, 6 records), all rooted at `addProductsToCart`, inputs `CartItemInput`.
- **Update** — `updateItemInCart` (6 records), rooted at `updateCartItems`: 3 × single-line `($cartId: String!, $itemId: ID!, $quantity: Float!)` with input field `cart_item_uid`, and 3 × list `($cartId: String!, $cartItems: [CartItemUpdateInput!]!)`.
- **Remove** — `RemoveItemForMiniCart` (unchanged from rev 1), rooted at `removeItemFromCart`, input `cart_item_uid`.

What the sources prove: document text, operation/root-field names, declared variable types, input field names where inline, and selection shape. What they do **not** prove, and nothing here claims: absolute-versus-delta quantity, merge/replace behaviour, quantity-step enforcement, live success of any operation, or address binding. The protected live cart (2 lines, total quantity 1.5) was not touched by this task.

Scope: static reads of supplied public JS only. No network, no login, no private auth/profile/vault/config/env, no primary probe scripts, no cart change, no commit, no push. Only this document changed; `scripts/cart_contract_extract.py` unchanged by this task (an earlier separate repair made it write into a per-run `mkdtemp` dir mode `0700` with the artifact at mode `0600` and strict UTF-8 — hence the changing output path above, old predictable path never written) — still preserved for separate review. No backend/schema behaviour inferred from Magento convention.

User-supplied baseline, **not re-probed**: primary live cart **2 lines, total quantity 1.5**; both protected, neither a test fixture. Address observation: `customerCart.shipping_addresses` queried with `customer_address_id`, `city_code`, `ward_code` returned HTTP 200, but the current row has all three missing and `is_new_administrative: false`. HTTP success and store selection do **not** establish address binding.

## Reproducibility

Paths relative to `/home/openclaw/.hermes/workspace/`. **Offsets are the zero-based UTF-8 byte offset of the opening JS quote**, and each record's `document` length is the decoded length, so the raw span is `[offset, offset + encoded_span)` where the encoded span is longer than the decoded text because newlines are stored as the two-character escape `\n`. Ranges below are given as `offset … +decoded_len` and must be read as *start offset + decoded length*, not as contiguous raw byte bounds. Fragment spreads require their definitions — a snippet with a spread is not a standalone request.

Runnable extractor (stdlib only, read-only over the four public chunks; prints counts and assert results only, never documents — this run is itself the required check):

```bash
cd /home/openclaw/.hermes/workspace/mm-cart-contract-next && python3 scripts/cart_contract_extract.py
# stdout ends: documents written: 13 -> /tmp/mm-cart-operations-<random>/mm-cart-operations.json
#              count AddProductToCart: 1  count AddItemToCart: 6  count updateItemInCart: 6
#              quote styles: {"'": 6, '"': 7}  decode_failures: 0
#              SELFCHECK OK
```

Verify a file hash with `sha256sum FILE`.

## Source hash / offset ledger

| Key | Public file | SHA-256 |
| --- | --- | --- |
| U1 | `mm-public-auth/RootCmp_CATEGORY__default.128ba67e6de0592532c9.js` | `b138d920c362b419fb90e1005702bb6de47ff26671d9907a9dcd44ef3605a0d1` |
| U2 | `mm-public-auth/RootCmp_PRODUCT__default.69076e524fe78a5faa74.js` | `fce80cfefdc0b545bb0cafdbcae4a0dd0cf154ea7b0fe0df8ce4877b7cfc50a4` |
| U3 | `mm-public-auth/RootCmp_SEARCH__default.d9f8e2c57e1715c1fac3.js` | `5c44c3fa693cf3d18f12accdccd847d1ff3ff7d658f5bf4b40c56289b68c73ec` |
| V | `mm-public-auth/vendors~RootCmp_PRODUCT__default.6124070c293c786bc499.js` | `08acfea7f7d982d73d332761cd09986fbf88409f36568d5aacc48875dd77144b` |
| A | `mm-asset-client.621acc48af8c317cdd54.js` | `9a5bceab01afed2fefcd3ba5a6986cad1b3bbdd34907e73b79ed1401c388f615` |
| C10 | `mm-public-auth/10.d39eacd8808a567ff1fb.js` | `8ac546c6d77bb997baba24d2e9693781cfc6f99760541a81157e90f46e1ff502` |
| C35 | `mm-public-auth/35.831e29aff2831ef53266.js` | `1a0168ca871a3d27a859ba5867713ed32a0ea9097051b1ca098801271ecbb8e7` |
| C45 | `mm-public-auth/45.689b309efd1d813a148c.js` | `d763b076f72a026942d9a82f77216960bfa4ef6935848049f6ca9ebf09e35239` |

The 13 extractor records (quote style; opening-quote byte offset; decoded length; signature; fragment spreads):

| # | Src | Quote | Offset | Decoded len | Operation signature | Fragment spreads |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | U1 | `"` | 268102 | 1732 | `AddItemToCart($cartId: String!, $cartItems: [CartItemInput!]!)` | — |
| 2 | U1 | `"` | 269925 | 1729 | `AddItemToCart($cartId: String!, $cartItem: CartItemInput!)` | — |
| 3 | U2 | `"` | 313440 | 1732 | `AddItemToCart($cartId: String!, $cartItems: [CartItemInput!]!)` | — |
| 4 | U2 | `"` | 315263 | 1729 | `AddItemToCart($cartId: String!, $cartItem: CartItemInput!)` | — |
| 5 | U3 | `"` | 459562 | 1732 | `AddItemToCart($cartId: String!, $cartItems: [CartItemInput!]!)` | — |
| 6 | U3 | `"` | 461385 | 1729 | `AddItemToCart($cartId: String!, $cartItem: CartItemInput!)` | — |
| 7 | V | `"` | 96765 | 377 | `AddProductToCart($cartId: String!, $product: CartItemInput!)` | `CartTriggerFragment`, `MiniCartFragment` |
| 8 | U1 | `'` | 255888 | 2226 | `updateItemInCart($cartId: String!, $itemId: ID!, $quantity: Float!)` | `ShippingSummaryFragment`, `TaxSummaryFragment`, `DiscountSummaryFragment`, `GrandTotalFragment` |
| 9 | U1 | `'` | 258268 | 2184 | `updateItemInCart($cartId: String!, $cartItems: [CartItemUpdateInput!]!)` | same four |
| 10 | U2 | `'` | 308127 | 2226 | `updateItemInCart($cartId: String!, $itemId: ID!, $quantity: Float!)` | same four |
| 11 | U2 | `'` | 310507 | 2184 | `updateItemInCart($cartId: String!, $cartItems: [CartItemUpdateInput!]!)` | same four |
| 12 | U3 | `'` | 380322 | 2226 | `updateItemInCart($cartId: String!, $itemId: ID!, $quantity: Float!)` | same four |
| 13 | U3 | `'` | 382702 | 2184 | `updateItemInCart($cartId: String!, $cartItems: [CartItemUpdateInput!]!)` | same four |

Normalisation cross-check (verified): the three bulk adds (#1,3,5) are identical after whitespace/comment normalisation; the three single adds (#2,4,6) likewise; the three single-UID updates (#8,10,12) likewise; the three list updates (#9,11,13) likewise. Hence **13 records → 5 distinct texts**. Quote-style split: `"×7`, `'×6`; `decode_failures: 0`. Per-file distribution: U1 and U2 and U3 each hold 2 add records (`AddItemToCart` bulk + single) and 2 update records (single-UID + list); V holds 1 (`AddProductToCart`). No `AddProductToCart` exists in U1/U2/U3 and no `AddItemToCart` exists in V.

## Write operations — evidenced vs. unresolved

| Action | Root field (evidenced) | Identifier / input (evidenced) | Unresolved (must be verified live) |
| --- | --- | --- | --- |
| Add, vendor single | `addProductsToCart(cartId: $cartId, cartItems: [$product])` | args `cartId`, `cartItems`; item type `CartItemInput`; response `cart { id ...CartTriggerFragment ...MiniCartFragment }` + `user_errors { code message }` | merge vs new line; `CartItemInput` internals; step/min/max; whether `user_errors` ever populates |
| Add, bulk | `addProductsToCart(cartId: $cartId, cartItems: $cartItems)` | `[CartItemInput!]!`; response adds `prices{discounts,grand_total,subtotal_*}`, `total_quantity`, `items{uid,product{id,uid},prices{...},quantity}` + `user_errors` | same |
| Add, app single | `addProductsToCart(cartId: $cartId, cartItems: [$cartItem])` | one `CartItemInput` wrapped into the list at call site — backend arg is always the list | same |
| Update, single line | `updateCartItems(input: {cart_id: $cartId, cart_items: [{cart_item_uid: $itemId, quantity: $quantity}]})` | line by **`cart_item_uid`**; `$quantity: Float!`; `cart_item_id` appears in **no** record | absolute vs delta; step enforcement; whether `$itemId` is the same value as read `items.uid` |
| Update, list | `updateCartItems(input: {cart_id: $cartId, cart_items: $cartItems})` | `[CartItemUpdateInput!]!`; member field names **not** in the document (no `cart_item_uid` here) | member field names + identifier type; quantity semantics |
| Remove | `removeItemFromCart(input: {cart_id: $cartId, cart_item_uid: $itemId})` | line UID, `ID!` | wire document evidenced, not backend-tested |

Do not collapse these: **add** uses `CartItemInput`, **list update** uses `CartItemUpdateInput` — two distinct types; do not assume the latter contains `cart_item_uid`. `ID!`/`Float!` are declared GraphQL types: `ID` is opaque (not integer); `Float!` is required non-null and says nothing about replacement-vs-delta.

### Exact single-UID update (records #8/#10/#12, identical; comments retained)

```graphql
mutation updateItemInCart($cartId: String!, $itemId: ID!, $quantity: Float!) {
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
```

### Exact list update (records #9/#11/#13)

Differs only in declaration and argument — `$cartItems: [CartItemUpdateInput!]!`, `cart_items: $cartItems`; response selection identical to the above. No `cart_item_uid`, no `cart_item_id` visible: the type's internals are unknown.

### Exact adds

```graphql
# V [96765 …] — vendor single add (records #7)
mutation AddProductToCart($cartId: String!, $product: CartItemInput!) {
  addProductsToCart(cartId: $cartId, cartItems: [$product]) {
    cart { id ...CartTriggerFragment ...MiniCartFragment }
    user_errors { code message }
  }
}

# U1 #1 / U2 #3 / U3 #5 — bulk add
mutation AddItemToCart($cartId: String!, $cartItems: [CartItemInput!]!) {
  addProductsToCart(cartId: $cartId, cartItems: $cartItems) {
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
}

# U1 #2 / U2 #4 / U3 #6 — single add; identical response, one-element list
mutation AddItemToCart($cartId: String!, $cartItem: CartItemInput!) {
  addProductsToCart(cartId: $cartId, cartItems: [$cartItem]) { /* same response shape as bulk */ }
}
```

`CartItemInput` internals (which product/quantity/option fields are actually filled) are **not** in these documents — only the type name appears. Subtype option encoding for configurable/bundle/grouped stays unproven.

### Exact remove (unchanged; A `[792289, 794463)`, repeated `prices` selections retained)

```graphql
mutation RemoveItemForMiniCart($cartId: String!, $itemId: ID!) {
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
```

## Correction note: why rev 1 said "missing"

Rev 1 searched only `mm-asset-client.621acc48af8c317cdd54.js` (A) and `mm-public-auth/10`/`35` for add/update literals, and treated quoted strings generically instead of quote-style-aware. The add documents live in `RootCmp_CATEGORY/PRODUCT/SEARCH` and `vendors~RootCmp_PRODUCT` (quote `"`); the update documents live in the same three `RootCmp_*` chunks (quote `'`). None of those four files were in the rev 1 search set, hence the false "not found". This is a search-coverage error, not absence of evidence.

## Identifiers and subtype handling

- Full cart reads select **line** `items.uid` and `items.id`, and separately **product** `product.uid` and `product.id`. Keep distinct. Remove and single-UID update address the line by `cart_item_uid`; no document anywhere uses `cart_item_id`.
- `updateItemInCart` is one operation name, two shapes (single-UID inline list element, or `$cartItems` variable). Do not infer `CartItemUpdateInput` member names.
- The correspondence between read-side `items.uid` and write-side `cart_item_uid`/`$itemId` is plausible but **unproven**; it must be established live before any write is enabled.
- Generic configurable update in A (byte ~144282) branches on `"ConfigurableProduct" === productType`, then remove-then-re-add, passing `item: {id: cartItemId}` into a helper that reads `item.uid` — visible mismatch, two-write partial-failure exposure. **Do not copy that path.**
- Reads contain `... on ConfigurableCartItem { configurable_options { id configurable_product_option_uid option_label configurable_product_option_value_uid value_label value_id } }` and `... on ConfigurableProduct { variants { attributes { uid code value_index } product { uid stock_status small_image { url } } } }`. Read shapes only; not add/update option encoding, not parent/child SKU semantics.
- `mm_product_type`, `mm_qty_step`, `unit_ecom`, `mis_stock.max_qty`, `mis_stock.can_add_to_cart` are selected in read fragments; enum values, defaults, authoritative constraints and units are unestablished. Bundle/grouped/downloadable/virtual/gift-card writes stay unevidenced. Fail closed on unknown subtype; never treat configurable or unknown as simple.

## Quantity semantics — known vs. not

**Known from source:** update declares `$quantity: Float!` and passes it through unchanged (`{cart_item_uid, quantity}` or a `CartItemUpdateInput` element); add takes `CartItemInput` with no quantity type visible.

**Not known, not asserted:** whether `Float` means absolute replacement or a delta; how `mm_qty_step`/`unit_ecom` constrain values; rounding; min/max; whether add increments an existing line or creates a new one; whether `quantity: 0` in an update means remove. None is provable from the literals.

User baseline shows fractional aggregate quantity (1.5) in this cart — not a universal allowed increment. Preserve `1.5`; never truncate, never default every line to one, never equate line count with total quantity. A selects `total_summary_quantity_including_config` in `CartTriggerFragment` `[617987, 618127)` — a distinct counter, not interchangeable with `total_quantity`.

Future boundary validation must reject nonfinite/nonpositive quantities and invalid identifiers and use decimal-safe step checks against *verified* product constraints, inventing no default step. Quantity zero must require explicit remove intent. All write paths stay disabled until absolute/delta semantics and subtype rules are verified live.

## Public reads, prices and errors

```graphql
# C35 [164326,164481)
query GetCartDetails($cartId: String!) { cart(cart_id: $cartId) { id ...CartPageFragment } }
# C10 [7303,7463)
query getPriceSummary($cartId: String!) { cart(cart_id: $cartId) { id ...PriceSummaryFragment } }
# A [289474,289698)
fragment CartPageFragment on Cart { id total_quantity ...AppliedCouponsFragment ...GiftCardFragment ...ProductListingFragment ...PriceSummaryFragment }
# C35 [165075,165220)
query CheckPriceChange($cartId: String!) { CheckPriceChange(cart_id: $cartId) { is_price_change } }
# C45 [31191,31337)
query GetCustomerCartAddress { customerCart { id ...ShippingInformationFragment } }
```

`ProductListingFragment` A `[285315,289252)`, whitespace compacted:

```graphql
fragment ProductListingFragment on Cart {
  id
  items {
    comment uid id have_same_promotion have_great_deal
    product {
      id uid art_no name ecom_name is_alcohol
      mis_stock { status label max_qty can_add_to_cart unavailable_reason notice }
      mm_product_type mm_qty_step unit_ecom sku url_key canonical_url thumbnail { url }
      dnr_price { qty promo_label promo_type promo_amount promo_value event_id event_name }
      dnr_mcard { event_id event_name promo_type promo_value cta }
      small_image { url }
      price_range { maximum_price { final_price { currency value } regular_price { currency value } discount { amount_off } } }
      price { regularPrice { amount { value } } } stock_status
      ... on ConfigurableProduct { variants { attributes { uid code value_index } product { uid stock_status small_image { url } } } }
    }
    prices { price { currency value } row_total { value } total_item_discount { value } }
    quantity errors { code message }
    ... on ConfigurableCartItem { configurable_options { id configurable_product_option_uid option_label configurable_product_option_value_uid value_label value_id } }
  }
}
```

Price/dependency fragments (unchanged):

```graphql
# A [819082,820150)
fragment PriceSummaryFragment on Cart {
  id
  applied_am_gift_cards { code expiration_date current_balance { value currency } applied_balance { value currency } }
  items { uid quantity }
  ...ShippingSummaryFragment
  prices {
    ...TaxSummaryFragment ...DiscountSummaryFragment ...GrandTotalFragment
    subtotal_with_discount_excluding_tax { currency value }
    subtotal_excluding_tax { currency value }
    subtotal_including_tax { currency value }
  }
  ...GiftCardSummaryFragment ...GiftOptionsSummaryFragment
}
# A [617526,617845)
fragment ShippingSummaryFragment on Cart { id shipping_addresses { selected_shipping_method { amount { currency value } method_title } street } }
# A [436891,437073)
fragment TaxSummaryFragment on CartPrices { applied_taxes { amount { currency value } } }
# A [695259,695461)
fragment DiscountSummaryFragment on CartPrices { discounts { amount { currency value } label } }
# A [818917,819052)
fragment GrandTotalFragment on CartPrices { grand_total { currency value } }
# A [289306,289432)
fragment AppliedCouponsFragment on Cart { id applied_coupons { code } }
# A [285189,285273)
fragment GiftCardFragment on Cart { __typename id }
# A [818622,818713)
fragment GiftCardSummaryFragment on Cart { id __typename }
# A [818755,818849)
fragment GiftOptionsSummaryFragment on Cart { id __typename }
```

Surface asymmetry to note: **add** documents select `discounts`/`grand_total`/subtotals inline plus `user_errors`; **update/remove** documents use fragment spreads with per-line `errors` and expose no `user_errors`. Every one of these is a partial view; none is a complete cart. Do not compute a quote from catalog price × quantity; do not treat `CheckPriceChange.is_price_change` as a complete quote. `totals_tax` appears in update/remove responses but not in `PriceSummaryFragment` — absent fields are unknown, not zero. Missing money currencies must not be fabricated.

Required eventual sequence: fresh owner-bound pre-read → validate exact line/options/quantity, stock, address → snapshot full lines/errors/prices/totals/currency/store context → execute **one** verified operation → fresh owner-bound post-read → compare expected changes, protected lines, returned quantity, errors, monetary change. Apollo cache is not reconciliation evidence. HTTP 200, non-null `data`, or mutation completion alone never means success; partial data plus errors is never clean success.

Invalid-cart matcher at A byte 146745 recognizes `Could not find a cart`, `The cart isn't active`, `The current user cannot perform operations on cart`. Browser code has cart recreation/sign-out/retry paths — those are **not** server adapter policy: stop on ownership/inactive errors; never create/merge carts, sign in/out, replay against a replacement cart, or repair stock automatically. A also holds a misleadingly declared `query removeItemNotVisibleFromCart` at byte 781671 — exclude from read allowlists. No `removeAllCartItems`, stock-fix, checkout or order action permitted.

## Owner binding and blocked address binding

Future server adapter must obtain the cart ID through authenticated **server-side `customerCart.id`** with trusted owner-session mapping. Public `GetCustomerCartAddress` proves a no-cart-variable selection path, not that a secure adapter exists. Accept no caller `cartId` in tools/API input — reject it rather than forward or silently ignore it. Browser storage `cartId`, untrusted cookies, masked IDs prove nothing about ownership. Line UID input must resolve inside that same fresh owner cart. Re-resolve owner/cart before dispatch and before reconciliation; changed/missing cart or mismatched owner means stop, never retarget.

Tension to resolve at implementation time, not here: every evidenced write document **takes** `$cartId: String!` (browser-style, cart-ID-parameterised), while the shipped MCP tools and the owner-bound design accept **no** cart-id parameter. The bridge — `customerCart.id` fetched server-side and passed into the write document internally, never caller-supplied — is a design decision still to be built and verified; the sources neither require nor forbid it.

C45 `ShippingInformationFragment` `[6371,7324)`, comments omitted:

```graphql
fragment ShippingInformationFragment on Cart {
  id email
  shipping_addresses {
    customer_address_id pickup_location_code is_new_administrative city
    country { code label } firstname street telephone city_code district district_code ward ward_code
  }
  delivery_date { date time_interval_id comment from to }
  vat_address { customer_vat_id company_name company_vat_number company_address }
}
```

Missing `customer_address_id`/`city_code`/`ward_code` today means address binding unproven. `is_new_administrative: false` is an observed flag, not permission to infer codes or migrate an address. Require independently verified owner/address/cart/store consistency before enabling writes; fill no gap from store labels, location selection, another profile, or guessed defaults. This task authorizes no address write and no private address lookup.

## Ambiguous outcome: reconcile, never blind retry

After timeout, connection loss, malformed response, or GraphQL partial failure the operation **may already have applied**. Preserve server-side intent ID and pre-state; mark pending/unknown; prevent a second mutation for that intent. A local intent record prevents local duplicate dispatch, **not** backend exactly-once execution.

- Re-read through owner binding without mutation. Compare full line UID/SKU/options/quantity/error/price/totals against pre-state and the verified expected effect. Serialize cooperating writes per owner/cart; detect external concurrent changes. Local locking cannot exclude browser/other-client writes.
- **Remove:** target UID absent and unrelated lines unchanged is *consistent with* applied removal — not proof this request caused it. Target still present does not automatically authorize replay.
- **Add:** merge-vs-new-line behaviour appears only in the operation name; the documents do not state whether an identical SKU merges into an existing line or creates a new one. Until verified live, reconciliation cannot classify add success safely. Never re-add after a timeout.
- **Update:** a matching desired quantity only becomes meaningful after absolute-vs-delta semantics are verified live. Configurable remove/re-add can be partly applied; never replay either leg automatically.
- If the read fails, the cart changed, concurrent edits appear, duplicates exist, or attribution is uncertain: retain unknown/conflict, report fresh observed state, require explicit resolution. Unchanged reads do not prove a timed-out request cannot commit later. No retry/backoff middleware may resend mutations. Bound reconciliation reads; exhausted reads stay unknown.

## Minimal future split and fake-test gate

**Design only; no files proposed for immediate creation.**

1. **Server cart adapter:** trusted owner/cart resolver (`customerCart.id` server-side; no caller cart-id), exact document allowlist limited to the five texts above, input/subtype/quantity checks, intent guard, one mutation dispatch, owner-bound reconciliation. Existing session/transport primitives only; no new dependency.
2. **Intent/UI layer:** explicit add/update/remove intent with expected pre-state and confirmation; pending/unknown/conflict display; no direct credentials or cart IDs; no retries; no optimistic success. Pure fake fixtures alongside the adapter using existing Node assertion tooling.

Fake acceptance must pass before any separately authorized live write; none has been run or claimed here:

| Fixture/test | Required acceptance |
| --- | --- |
| Exact wire snapshots | Operation name, variable declarations, arg names and fragment closure match the cited sources for all five texts; no guessed fallback; no `cart_item_id`; no invented `CartItemUpdateInput` internals. |
| Owner isolation | Caller cart ID rejected; owner A cannot reference owner B's cart/line; changed owner/cart aborts before dispatch and reconciliation. |
| UID versus numeric ID | Fixture has distinct line UID, numeric line ID, product UID/ID and SKU; remove and single update send line UID only; mapping read `items.uid` → write `cart_item_uid` proven before enable. |
| Protected baseline | Fake cart: two lines summing to 1.5; missing address fields and false administrative flag produce zero mutation calls; a separate fully bound synthetic fixture is used for future success tests. No live-cart fixtures. |
| Fraction/step validation | Preserve fractions; reject NaN, infinities, negatives, zero quantity, invalid steps and stock violations. Missing authoritative constraints fail closed; no default step invented. |
| Product subtypes | Simple/configurable/unknown fixtures; unsupported shapes produce zero calls. Never copy the mismatched `{id}`/`.uid` configurable remove/re-add path. |
| Error channels | HTTP failures, HTTP 200 GraphQL errors, partial data, per-line errors, null/mismatched cart, incomplete totals: never clean success. |
| Fresh pre/post reads | Stale cache rejected; compare protected lines, options, quantities, stock, discounts, taxes, totals, currencies. Price changes surfaced; missing values not zeroed. |
| Applied timeout | Fake backend applies then times out; reconciliation observes the effect; total mutation count exactly one. No causal proof claimed under external concurrency. |
| Unapplied/delayed timeout | Unchanged/failed read or later commit stays unknown; mutation count exactly one, including repeated intent submission. |
| Concurrent/partial outcome | External line edits, duplicate matching SKUs, replacement cart, partial configurable work, changed prices → conflict/unknown; no automatic compensating write. |
| No hidden writes | Fail the test on create/merge/clear cart, stock fix, address/store write, checkout, order, or query-named cleanup. Mutation retry middleware disabled. |

## Remaining gates (all OPEN — nothing here authorizes a write)

1. Live confirmation of `CartItemUpdateInput` member field names and identifier type.
2. Live confirmation of `CartItemInput` internals and per-subtype option encoding.
3. Absolute-vs-delta update quantity semantics.
4. Add merge-vs-new-line semantics.
5. Authoritative quantity step/min/max (`mm_qty_step`, `unit_ecom`, `mis_stock`).
6. Owner-bound bridge from `customerCart.id` to the `$cartId`-parameterised documents, with no caller-supplied id.
7. Address binding verification (currently blocked: `customer_address_id`/`city_code`/`ward_code` missing, `is_new_administrative: false`).
8. Deterministic fake suite passing.
9. Separate explicit approval plus an isolated, non-protected live fixture.

**This document verifies document text and offsets only — it does not verify the write contract end-to-end, and authorizes no implementation and no live experiment. Protected live cart (2 lines, qty 1.5) untouched.**
