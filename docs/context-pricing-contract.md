# Selected delivery context and account catalog pricing

Status: source-only contract, 2026-10-31. Base commit
`958e1a6e74d1c45e94482490096ae62a51a09790`. No live calls, credentials,
browser profile, environment secrets, private captures, or mutations used.
Discovery above was source-only. Primary read-only replay results (2026-11-01):

- Owner-bound address query: HTTP 200, zero GraphQL errors, Customer typename
  and configured store matched. One shipping row; street was an array, but
  `customer_address_id`, `city_code`, and `ward_code` were absent/empty.
  `is_new_administrative` was false; no pickup code was present. No private
  address values or identifiers retained. Schema acceptance is proven for
  this observation; selected-address binding remains unverified.
- Same-store, same-SKU detail sequence guest/auth/guest passed identity and
  money-shape checks with equal observed prices. This proves neither member
  entitlement nor a general absence of account-specific pricing.
- Primary verified all 17 source sizes/SHA-256 entries below. No mutations
  or runtime edits performed. New address implementation remains blocked.

## Findings and current ceiling

- Saved `customer.addressesV2.addresses[].default_shipping` is address-book data,
  not proof of either cart shipping or current browser delivery selection.
- Current `MMCartRead` requests shipping method only; no address identity is
  available to join to browser selection. Store proof alone cannot bind address.
- Public browser code reads `customer_address`, `store_view_code`, and
  `isAddressChanged`; default address can seed browser state conditionally.
- Catalog code is explicitly guest-only. `dnr_mcard` is raw promotion metadata,
  not customer-group membership or a guaranteed payable/member price.
- Authorization-dependent pricing, selected-address/cart parity, and minimal
  query schema acceptance remain missing live proofs.
- Follow-up lazy-source discovery below establishes cart `city_code`,
  `ward_code`, and `customer_address_id`; these fields still need owner-query
  replay. Primary reports street-only HTTP 200 and equal guest/auth/guest
  detail prices for one SKU/store; neither establishes selected address or membership.

## Existing repository documents

`src/account.mjs:44` (exact):

```graphql
query MMReadProof($currentPage:Int=1$pageSize:Int=20){customer{__typename addressesV2(currentPage:$currentPage pageSize:$pageSize){total_count total_pages addresses{id default_shipping city street custom_attributes{attribute_code value}}}}storeConfig{store_code store_name}}
```

`src/account.mjs:52` (exact):

```graphql
query MMCartRead{customerCart{total_quantity items{uid quantity product{sku name} prices{price{value currency}row_total{value currency}}}prices{grand_total{value currency}subtotal_excluding_tax{value currency}}shipping_addresses{selected_shipping_method{method_title amount{value currency}}}}customer{__typename}storeConfig{store_code store_name}}
```

## Public GraphQL evidence (not schema guesses)

Public asset `B` below is the supplied client bundle. Code fences in this
section reproduce decoded GraphQL literal contents, excluding outer blank
lines. Offset ranges locate the original JSON-escaped JS string, including
quotes. They are not byte-for-byte request captures.

### Cart shipping: original main-bundle ceiling

The only literal public `customerCart` operation found in the original asset set
is this status query, **not a shipping-address query** (B bytes
`[490244,490691)`):

```graphql
    query GetEvoucherCartStatus {
        customerCart {
            id
            is_evoucher_payment_apply
#            prices {
#                grand_total {
#                    value
#                    currency
#                }
#            }
#            applied_am_gift_cards {
#                code
#                applied_balance {
#                    value
#                }
#            }
        }
    }
```

Do not replay this document for address binding: it requests cart ID without
providing address evidence. The public shipping fields come from this exact
fragment on `Cart` (B bytes `[617526,617845)`):

```graphql
    fragment ShippingSummaryFragment on Cart {
        id
        shipping_addresses {
            selected_shipping_method {
                amount {
                    currency
                    value
                }
                method_title
            }
            street
        }
    }
```

`MiniCartFragment` and `PriceSummaryFragment` reference this fragment (B UTF-16
offsets `787426` and `813174`). The adjacent `MiniCartQuery` uses
`cart(cart_id:$cartId)`, not `customerCart`; do not substitute a stored cart ID
for authenticated ownership. Public `customerCart` text has four occurrences:
one query, one response use, cache eviction, and cache policy. No literal
`customerCart` shipping-address document exists in that original asset set;
lazy `GetCustomerCartAddress` below now supplies one via fragment spread.
The repository's `MMCartRead` above is the existing owner-query composition.
Adding `street` from the public `Cart` fragment is source-supported, but that
new composition still needs primary's live schema/ownership proof.

No public cart shipping selection in the original B plus chunks 5/6/11/44/66 establishes
`customer_address_id`, city/ward codes, address ID, or a selected-address flag.
Lazy chunks 35/40/45 now establish the first three; see follow-up below.
Do not invent other fields from Magento conventions. `shipping_address`
browser storage is another, separate cache: public code saves it after a
shipping mutation response (B bytes `[398416,399416)`); no such mutation ran.
This does not make it current header selection or fresh server truth.

### Follow-up: lazy checkout/address binding evidence

Public files already present in P resolve the missing field evidence; no
additional chunk fetch is needed for this read contract. Runtime public path
is `https://cdn-b2c.mmpro.vn/`, with literal ID/hash mappings:
P35/P40/P45 below denote the exact matching chunk filenames in this list.

- `/checkout`: B bytes `[799685,799786)` defines lazy `de`, loading chunks
  `6,10,40,5,35`, then module `l4aF`; route marker starts at byte `802503`.
- `/address-book`: lazy `pe` starts at B byte `799888`, loads `4,45`, then
  module `qFp3`; route marker starts at byte `802675`.
- Checkout query module `DLKn` is in
  `https://cdn-b2c.mmpro.vn/40.26a6b5d4df03f768d5f8.js`; it imports `Lqle`.
  Checkout `Lqle` is in
  `https://cdn-b2c.mmpro.vn/35.831e29aff2831ef53266.js`.
- Address-book duplicates both modules in
  `https://cdn-b2c.mmpro.vn/45.689b309efd1d813a148c.js`.

**Owner read found:** module `dCvR` imports `Lqle` and exports
`getCustomerCartAddressQuery`. Exact decoded literal at P40 bytes
`[25365,25511)` equals P45 `[31191,31337)`:

```graphql
    query GetCustomerCartAddress {
        customerCart {
            id
            ...ShippingInformationFragment
        }
    }
```

Raw quoted-literal SHA-256:
`dc900d93afdbc12302a3ea13a34bbaab07aaa684056329ee2d6d662307bcf5e4`.
This establishes the owner root plus exact fragment, without any cart-ID
substitution. P35 `lMQn`, byte `271961`, consumes this operation when signed
in with `cache-and-network`; browser cache alone is not fresh live proof.

`DLKn` exports `getShippingInformationQuery`; decoded literal at P40 bytes
`[11572,11746)` is identical to P45 `[3766,3940)`:

```graphql
    query GetShippingInformation($cartId: String!) {
        cart(cart_id: $cartId) {
            id
            ...ShippingInformationFragment
        }
    }
```

`Lqle` exports `ShippingInformationFragment on Cart`, P35
`[87923,88876)`, identically P45 `[6371,7324)`. Its literal
`shipping_addresses` selection includes `customer_address_id`,
`pickup_location_code`, `is_new_administrative`, `city`, `street`,
`city_code`, `district`, `district_code`, `ward`, and `ward_code`.
Full fragment also requests email/name/phone/VAT/delivery data: **do not
replay it wholesale**. Raw quoted-literal SHA-256:
query `872c5de30d34db7f9875f94f3aeb6371763980447dd9c40c70a9326490b720d1`;
fragment `a92b4076c338c6945040744e0515d7dfad2ec989dae2cc4848d5a13bf5b4e6b3`.

Consumer evidence: P35 module `Q8HU`, byte `146625`, reads this query using
current cart ID and `cache-and-network`. Module `lMQn`, byte `274492`,
requires shipping `customer_address_id`, city/ward codes and nonempty street
array, then passes that ID as `addressId` and seeds local selected-address
state from the cart fields. This is source linkage to a saved-address ID,
not a dedicated shipping-row ID or proof of browser selection. This effect
also invokes an address mutation: **do not open checkout to obtain proof**.
Only replay the pruned read below; no mutation was executed here.

P35 module `svUz` constructs persisted `customer_address` from
`{city_code,ward_code,address,address_details}` (write at byte `326631`),
without saved-address ID. Thus cart ID linkage cannot by itself join to
header selection. No selected-address boolean is established. Browser/cart
descriptor equality needs independent fresh, settled browser evidence.

### Saved address book (not selected delivery)

B bytes `[93072,93576)` plus fragment `[1031128,1031475)`:

```graphql
    query GetCustomerAddressesForAddressBook (
        $currentPage: Int!
        $pageSize: Int!
    ) {
        # eslint-disable-next-line @graphql-eslint/require-id-when-available
        customer {
            addressesV2 (
                currentPage: $currentPage
                pageSize: $pageSize
            ) {
                addresses {
                    id
                    ...CustomerAddressBookAddressFragment
                }
            }
        }
    }
```

```graphql
    fragment CustomerAddressBookAddressFragment on CustomerAddress {
        __typename
        id
        firstname
        telephone
        default_shipping
        is_new_administrative
        country_code
        city
        street
        custom_attributes {
            attribute_code
            value
        }
    }
```

These are evidence, **not recommended replay documents**: the fragment asks
for name/phone. The repository omits those direct fields, but unrestricted
custom-attribute values are not a proven privacy whitelist either. Avoid
address-book reads entirely for the minimal selected-context replay. IDs and
`default_shipping` describe saved rows, not current browser/cart identity.

### Browser delivery routing documents

B bytes `[92850,93042)` is a fallback query, not saved-customer default_shipping:

```graphql
    query getAddressDefault {
        addressDefault {
            city_code
            city_name
            ward_code
            ward_name
            address
        }
    }
```

B bytes `[778701,779214)` is an existing read-only routing query:

```graphql
    query GetStoreView ($street: String!, $city: String!, $ward: String!, $language: String!, $website: String!, $withDistance: Boolean = true) {
        storeView(street: $street, city: $city, ward: $ward, language: $language, website: $website, with_distance: $withDistance) {
            store_view_code {
                store_view_code
                source_name
                priority
                distance
            }
            message
            allow_selection
        }
    }
```

The browser also has `GetStoreViewDetail` (B bytes `[779244,780526)`), which
adds `$cartId` and cart stock/shipping diagnostics. Exclude it: cart ID is
unnecessary for this read-only routing check. `GetStoreInformationQuery`
(`[780556,780768)`) describes the store itself; its `address` is not customer's
delivery address. `getWardAndCity` (`[781449,781641)`) resolves code labels;
labels alone are not address identity.

## Selected browser state and lifecycle

Storage implementation (B bytes `[272201,273351)`): `BrowserPersistence.KEY`
is `M2_VENIA_BROWSER_PERSISTENCE`. Logical key `customer_address` therefore
uses localStorage key `M2_VENIA_BROWSER_PERSISTENCE__customer_address`.
Wrapper is `{value: JSON.stringify(payload), timeStored, ttl}`; `getItem`
decodes twice and discards expired entries. Never treat raw storage JSON as
the actual address object.

Relevant logical keys and payloads:

| State | Meaning and limits |
| --- | --- |
| `customer_address` | `{city_code, ward_code, address, address_details}`; selected browser delivery descriptor; `address` is street text and `address_details` is display text, not saved-address ID. Fallback may supply additional label fields. |
| `store_view_code` | Browser request store; default `b2c_10010_vi`. Not inherently equal to current account-module store. |
| `isAddressChanged` | Guards automatic default initialization; not server confirmation or cart sync proof. |
| sessionStorage `customerAddressData` | Pending candidate descriptor awaiting store-choice confirmation. Native session key, not persistence-wrapper key. |
| `store` | Cached storeInformation response; source/store metadata, not delivery selection. |
| sessionStorage `checkout_address` | Removed by header hook; cannot be assumed authoritative. |

Observed lifecycle (source only):

1. Header reads `customer_address.address_details` and requests saved addresses
   with `{currentPage:1,pageSize:1}` when signed in. If `!isAddressChanged`,
   first returned row has `default_shipping`, and row is new-administrative,
   it seeds `customer_address` using street plus `ward_code`/`city_code`
   custom attributes. It does not search all pages for a default. A legacy
   row can yield empty display/state. Otherwise it uses `addressDefault`
   fallback and can reset browser store to the default (B `[92822,97500)`).
2. Submitted location is routed via `storeView`; browser supplies
   `street:e.address`, city/ward codes, language, `website:"b2c"`, and
   `withDistance:false`. When returned store candidates exist, it sets
   `isAddressChanged:true` and stages `customerAddressData`, opening store
   choice. One alternate branch writes `customer_address` directly
   (B `[1176279,1178659)`). Staged data is not committed selection.
3. Store confirmation writes `store_view_code`, fetches storeInformation,
   consumes staged descriptor into `customer_address`, then navigates
   (B `[1179679,1180329)`). Transient/mixed snapshots are possible; capture
   only after navigation settles, then recheck both values.
4. Sign-in restoration can replace/remove `customer_address` and set store
   and change flag (B `[1233079,1233779)`). No assumption of persistence
   across account changes is safe.

Public Apollo links independently set `authorization` from stored sign-in
token and `store` from `store_view_code` (B `[1144119,1144699)`); default store
applies if missing. These are public code paths, not any token read here.
Thus saved default, cart shipping, and selected browser descriptor remain
three distinct sources even when strings happen to match.

## Minimal primary replay (not implemented, not live-verified)

Use only existing endpoint `https://online.mmvietnam.com/graphql`, GET with
JSON `query`/`variables` URL parameters, existing private Authorization and
explicit `store` headers. Never put token in URL, report, or logs. GET query
and variables contain address data; private replay must redact request URLs
and upstream bodies. Do not invoke checkout, store-switch, or address mutations.

Primary reports the former street-only candidate returned HTTP 200,
`customer.__typename:Customer`, matching store, and one shipping row with
street array. This is user-supplied live evidence, not a replay performed
here; selected-address binding remains unproven.

Next replay candidate: privacy-pruned/inlined from literal lazy
`GetCustomerCartAddress` and its `ShippingInformationFragment`, retaining
existing customer/store guards. This exact reduced document still needs replay:

```graphql
query MMSelectedDeliveryRead {
  customer { __typename }
  storeConfig { store_code }
  customerCart {
    shipping_addresses { street city_code ward_code customer_address_id }
  }
}
```

Variables `{}`. It intentionally excludes cart ID, saved-address book,
custom attributes, names, phone, email, method labels, and totals. Require
zero GraphQL errors, non-null `customer` with `__typename:"Customer"`, exact
requested/returned store equality, a valid owner cart, and structurally valid
shipping-address list. Empty shipping list means **unbound**, not default
address. Do not assume address scalar types until replay confirms them.

For routing, replay the existing `GetStoreView` document above, or this
explicitly **derived/pruned** candidate with no cart ID or personal labels:

```graphql
query MMSelectedDeliveryRoute($street:String! $city:String! $ward:String! $language:String! $website:String!) {
  storeView(street:$street city:$city ward:$ward language:$language website:$website with_distance:false) {
    store_view_code { store_view_code }
    allow_selection
  }
}
```

Primary supplies variables privately from settled browser descriptor:
`street=customer_address.address`, `city=city_code`, `ward=ward_code`,
`language="vi"` for this `_vi` store, `website="b2c"`. Require nonempty
well-formed input, same request/browser/account store, and requested store
present in returned candidates. Never auto-pick candidate index zero:
`allow_selection` and multiple candidates indicate routing is not unique.
Candidate membership proves routability, not chosen store or cart sync.

**Remaining gate:** lazy source now supports these exact cart fields; live
schema/type/nullability and selected-browser parity remain unproven. Require
one shipping row, nonempty city/ward codes, and exact code equality to fresh,
settled browser `customer_address`; compare `street.join(", ")` to browser
`address` (public UI's display join), without fuzzy/case/accent normalization.
Mismatch or ambiguous street representation stays unresolved. Matching these
values supports descriptor parity only, not unique saved-address identity.
Non-null `customer_address_id` supports saved-row linkage only if privately
matched to independently evidenced saved-row ID; never match it to absent
browser ID or infer selection from `default_shipping`. Null/missing ID does
not prove guest status. Multiple rows, pickup ambiguity, stale state or errors
stay unverified. Do not mark `address_selection:verified` without primary's
live comparison and explicit review; no implementation change is proposed.
Return only redacted comparison outcomes/counts in review evidence; keep raw
street/codes private. Do not hash low-entropy addresses into public evidence.

## Account catalog pricing contract

What source establishes:

- `src/catalog.mjs:108` sends only `{store:storeCode}`. Both search stages
  share that guest store and use blank `asmUid` / `phoneNumber`. There is no
  Authorization, customer-group parameter, or selected-browser-address input.
  Guest store comes from `MM_STORE_CODE`, with no automatic account-store join.
- `CARD_QUERY` is `render_stage:CARD`; exact returned SKU list feeds
  `ENRICH_QUERY` with `render_stage:ENRICH`. `price_vnd` comes from
  `price_range.maximum_price.final_price.value`, regular price from
  `regular_price`, not legacy `price.regularPrice` or promotion arithmetic
  (`src/catalog.mjs:252`). Detail uses separate `DETAIL_QUERY`.
- `dnr_mcard { event_id event_name promo_type promo_value cta }` is raw
  metadata passed as `member_offer`; code never calculates member price.
  Public `ProductEnrichFragment` requests these fields and separately requests
  `product_label.customer_groups` (B `[1316320,1317870)`). Label targeting is
  not actual authenticated customer's group or entitlement proof.
- Public auth/store links show Authorization **can** accompany product
  operations. They do not show backend price-resolver logic or prove that
  prices change. No group identity field/query is established here.
- Existing account customer proof establishes authenticated customer, **not**
  MCard membership, customer group, promo eligibility, or payable checkout price.

**Answer:** current repository catalog is guest regardless of account auth.
Whether upstream varies catalog price with Authorization/customer group is
unknown from supplied public source and offline tests. It may vary; it must
not be asserted either way. Raw `dnr_mcard` is not that proof. Equal
guest/authenticated prices prove only equality for tested SKU/store/time,
not member eligibility, absence of account pricing globally, or shared group.

### Controlled price replay gates

Primary, using existing private auth only, should:

1. Establish live customer and exact same requested/returned store; settle
   browser descriptor and check route separately. Do not compare guest
   `b2c_10010_vi` to account `b2c_70010_vi` and attribute difference to auth.
2. Pair exact exported `CARD_QUERY` then `ENRICH_QUERY` under guest headers
   versus same store plus Authorization. Hold search, paging, exact compared
   SKUs, variables, blank ASM/phone, currency and near-time window constant.
   Record CARD membership changes separately from ENRICH price changes.
   Use repeat guest/auth/guest observations to expose time/cache drift.
3. Pair exact exported `DETAIL_QUERY` for same known url_key/SKU under both
   contexts; preserve SKU binding. Record final/regular price, currency,
   raw offer metadata, response errors, and observation times. Cross-stage
   differences need explanation, not silently choosing cheapest field.
4. Isolate guest from auth cookies/cache. If price differs with only auth
   changed, record observed account-context effect, not group causality.
   Customer-group/member attribution requires additional independently
   evidenced entitlement/group proof and an eligible product/control case.
   Cart totals remain separately upstream-observed, never payable guarantees.

## Proposed change and acceptance

No runtime change justified before replay. Keep current explicit
`address_selection` not-verified warning and guest catalog context.
Source now supports proposing read-only cart `street`, `city_code`,
`ward_code`, `customer_address_id` additions and a
privacy-limited comparison/routing observation, conditional on replay schema,
type, ownership and store checks. It does **not** support changing selected
address to verified or calling catalog account/member-priced.

After primary replay, the smallest possible production follow-up is separate
explicit authenticated catalog context using existing transport/price
projections **if** replay proves those exact query contracts. Do not silently
change guest-tool semantics, inject raw member promotion into price, add
unverified group fields, or add address selection/mutations.

Acceptance requires primary to review source offsets, privately validate
minimal query/route candidates, report only sanitized shape/parity results,
run paired same-store/SKU pricing evidence, and explicitly approve proposed
read-only diff. Missing cart geographic/ID linkage leaves address verification
blocked even if every other replay passes.

## Offline checks and evidence ledger

Follow-up source-only Node assertions checked duplicate owner/query/fragment
literal hashes, lazy checkout mapping, and pruned replay field/privacy scope.
No network, authenticated call, checkout execution or mutation was performed.

Executed only targeted fixture suites with global native `fetch` overridden
to throw (network disabled), and account live checks forced off:

- `scripts/catalog.test.mjs`: **40/40 passed**. Header exclusion at lines
  197–199; raw member offer leaves price unchanged at 390–397; detail guest
  context/raw offer test at 433–455.
- `scripts/account.test.mjs`: **33/33 passed; 2 live-only skipped**. Store
  mismatch and explicit not-verified context at 275–293; owner cart headers
  at 438; shipping count/method-only projection at 459–475.
- These tests validate current code/fixtures only, not new queries, live
  schema, browser freshness, auth pricing, membership or address equality.

Reproduction: `MM_LIVE_PARSE= node --import 'data:text/javascript,globalThis.fetch=()=>{throw new Error("Network disabled for contract review")}' scripts/account.test.mjs`;
same `--import` guard with `node scripts/catalog.test.mjs` for catalog.
No auth setup/live/probe scripts executed. No runtime edits, commit or push.

Offsets above are zero-based UTF-8 byte ranges `[start,end)` unless explicitly
labeled UTF-16 (JS string offsets). Hashes are SHA-256 over full file bytes.
B = `/home/openclaw/.hermes/workspace/mm-asset-client.621acc48af8c317cdd54.js`.
P = `/home/openclaw/.hermes/workspace/mm-public-auth/`.

| Source | Bytes | SHA-256 |
| --- | ---: | --- |
| B | 1529158 | `9a5bceab01afed2fefcd3ba5a6986cad1b3bbdd34907e73b79ed1401c388f615` |
| `src/account.mjs` | 27464 | `37382e04f9d5f67f14163be7a4913dbbfd79a54453e5df0d2a86ea060cf3ba98` |
| `src/catalog.mjs` | 26434 | `88e7695591fbc5c658e5b065a055f967ccaa5aa039de939a3d0525f19b446695` |
| `scripts/account.test.mjs` | 42935 | `f1f6961bfa0687062d8f21779792b95f3527b6663e09406778302a230ed1b1c7` |
| `scripts/catalog.test.mjs` | 41278 | `25095a0c5c6cfe0f2bf82d25cace7eb2f43078352b0e29c677366fadae9ce143` |
| P `11.dd7122ec3056d7a384e1.js` | 19647 | `2b4ee623d2403b399d4bf0a1c77605a5cd55fcb7bd9ea51ec7effc393bc444b0` |
| P `44.908ab587731c636828e7.js` | 14298 | `ba81e3ef8b9a35beedf5616c6ef49ae927814b300e9d2d7c0824d6056c50f113` |
| P `5.ff26e8164141544367c7.js` | 28896 | `4becf9278d7f8a5eed984f008e7bffb72df38026c15197f46ccc16bf0b024865` |
| P `6.fc78da1e934b65e93d7c.js` | 32107 | `d8eaf203a1704463652a52a679e411553e32453d711f971f9acf1fdcc66a3943` |
| P `66.5591a41a0ebc11016127.js` | 26346 | `7808926755292cace32d11f8ffa413303140befea4e9ea2c1be08e6361656da0` |
| P `runtime.js` | 6020 | `037eaef02a64ebc0fb30ce7237b06cca61c61d9bef3378d041731da7f26ec4b4` |
| P `10.d39eacd8808a567ff1fb.js` | 25781 | `8ac546c6d77bb997baba24d2e9693781cfc6f99760541a81157e90f46e1ff502` |
| P `35.831e29aff2831ef53266.js` | 328959 | `1a0168ca871a3d27a859ba5867713ed32a0ea9097051b1ca098801271ecbb8e7` |
| P `4.808d69e1d521e1073a98.js` | 68186 | `a3d089fed3476644134ac187e5ad8d2cdffc8e4915e640345c95ba6c51d26025` |
| P `40.26a6b5d4df03f768d5f8.js` | 28788 | `123f486aefeedbc2b65164ac0aa7f1984ed864afb440f8dbb2ca004b0518053e` |
| P `45.689b309efd1d813a148c.js` | 66891 | `d763b076f72a026942d9a82f77216960bfa4ef6935848049f6ca9ebf09e35239` |
| P `homepage.html` (hash only) | 69699 | `a822eb2ffa13ca9a017f0d68b42d08a92a6ee897c4f28646e26040a64e7f3ae6` |

Original B plus chunks 5/6/11/44/66 were term-scanned; no full minified file was
printed. Those smaller chunks contained no `customerCart`, `shipping_addresses`,
or `dnr_mcard` matches. This is a bounded asset-set absence, not a claim about
all website chunks or the upstream schema. Public literal raw-string hashes:

- Status `[490244,490691)`: `c126ca4847bfe157e642819fae8573e737b2e2549ecd55ed44bc4830c3e110a3`.
- Shipping fragment `[617526,617845)`: `932c2520b4aa57b893446b057cb28022b70cfe769a4ccb546782c1dd2b917d52`.
- Saved-address query `[93072,93576)`: `251ab8bcf2a603e936a7b6fb25cff4187c2b4e926976f15f947b13808e33d5ca`.
- Saved-address fragment `[1031128,1031475)`: `fe1176570acef8511d1086ce6d44c2f5bf7f618845d2aeb1712d6be69033af9c`.
