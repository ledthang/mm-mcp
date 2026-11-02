# Tools, configuration and error codes

Exact reference for the ten tools, the MCP framing this server accepts, and every error
code it can return. Everything here is read straight out of `src/server.mjs`,
`src/catalog.mjs`, `src/account.mjs` and `src/cart.mjs` — if this page and the source
disagree, the source is right.

## Framing

- Transport: stdio only. Input and output are newline-delimited JSON-RPC 2.0; a line is
  decoded as UTF-8 only once it is complete, so a multibyte character split across chunks
  survives. Decoding is fatal (`TextDecoder` with `fatal: true`): invalid bytes earn that
  line exactly one `-32700 Parse error` with `id: null`, and the next valid line is served
  normally. No `U+FFFD` substitution, so a damaged frame is never accepted as valid.
- Line limit: 64 KiB (`MAX_LINE_BYTES`). A longer line is never dispatched: it earns
  exactly one `-32700 Parse error` and the server keeps serving afterwards.
- Protocol version: `2024-11-05`, a constant. The server has no MCP SDK dependency (it speaks
  the wire itself) and does no negotiation beyond echoing that version in the `initialize`
  result. Client-side SDKs exist elsewhere — MCP Python SDK 2.0.0 sits in the Hermes venv, not
  in this repository's dependency set.
- Methods handled: `initialize`, `ping`, `tools/list`, `tools/call`. Anything else is
  `-32601 Method not found`.
- `initialize` must come first and must be exact: only `protocolVersion`, `clientInfo`
  (with non-empty `name` and `version`) and `capabilities` are accepted; any other key is
  `-32602 Invalid params`. Calling anything before `initialize`, or initializing twice,
  is `-32600 Invalid Request`.
- `tools/list` serves one page and never issues a cursor; a `cursor` that is present must
  be a non-empty string, otherwise `-32602 Invalid params`.
- Notifications (no `id`) get no reply, and change no state. An `id` must be a string or an
  integer.
- One request line produces at most one reply line, written and awaited before the next
  bytes are read (backpressure, no promise queue).
- `serverInfo` is `{ "name": "mm-mcp", "version": "0.1.0" }`; capabilities are
  `{ "tools": {} }` only — no resources, no prompts, no logging.

### Request metadata: `params._meta` accepted, then ignored (fixed locally 2026-11-01)

Every method's `params` is checked against a fixed key allowlist, and `_meta` — the
metadata key current MCP clients put on request params — was in none of them:

| Method | Allowlist (`src/server.mjs`) | `params._meta` now |
| --- | --- | --- |
| `initialize` | `INIT_KEYS` = `protocolVersion`, `clientInfo`, `capabilities` | object → accepted, ignored; else `-32602 _meta must be an object` |
| `ping` | none | object → accepted, ignored; else `-32602 _meta must be an object` |
| `tools/list` | `LIST_KEYS` = `cursor` | object → accepted, ignored; else `-32602 _meta must be an object` |
| `tools/call` | `CALL_KEYS` = `name`, `arguments` | object → accepted, ignored; else `-32602 _meta must be an object` |

Metadata is checked separately from the method arguments and never reaches a tool: an unknown
argument (e.g. `bogus`) is still refused, and `_meta` alongside it is named in the error as a
different key. Formerly, a client sending `_meta` on `initialize` never initialized and every
later request answered `-32600 not initialized`.

`scripts/stdio.test.mjs` now covers initialize/ping/list/call with valid and invalid metadata
(37 checks, all passing, offline). Nothing here certifies a specific client. The MCP Python
SDK 2.0.0 in the Hermes venv completed initialize / tools/list / tools/call against the
server (PASS, protocol `2024-11-05`, 7 tools, no upstream calls), but that is SDK evidence
with no Hermes configuration loaded; the configured Hermes session was not opened, so it
remains unverified. The old "Hermes fails to connect" note predates this fix and is not
supported by the SDK run either way. That run listed 7 tools: it predates the three cart
write tools and has not been repeated, so the cart tools have no SDK evidence either.

### Request ids: string or integer only (fixed locally 2026-11-01)

`isId` accepted any finite number, so `id: 2.5` was a valid request id and was echoed back —
a leniency, not protocol support. It now requires a string or an integer: `id: 2.5` and
`id: 1e999` (which parses to `Infinity`) are refused `-32600 Invalid Request` with
`id: null`, while `"abc-9"`, `"0"` and `241` are accepted and echoed unchanged. The pinned
MCP messages specification requires string or integer request ids, so this is conformance,
not a new feature. Covered by `scripts/stdio.test.mjs`.

## Result envelope

Every `tools/call` result is a single text block:

```json
{ "content": [{ "type": "text", "text": "<JSON projection>" }] }
```

Failures set `isError: true` and put one fixed code (optionally `: safe detail`) in the
text. There is no `structuredContent` and no `annotations` anywhere in this server — this
project targets MCP `2024-11-05` only. Raw upstream bodies and raw thrown messages never
reach the caller; an unrecognised internal failure is exactly `INTERNAL`.

## JSON-RPC level errors (from `src/server.mjs`)

| Code | Meaning |
| --- | --- |
| `-32700` | Parse error — invalid JSON, or a line over 64 KiB |
| `-32600` | Invalid Request — bad `jsonrpc`, bad `method`, bad `id`, not initialized |
| `-32601` | Method not found — anything other than initialize/ping/tools/list/tools/call |
| `-32602` | Invalid params — unknown params key, unknown tool name, bad `arguments` |

## Guest catalog tools (`src/catalog.mjs`)

Both need `MM_STORE_CODE` (format `b2c_<1–8 digits>_vi`); with it unset they fail
`MISSING_STORE_ENV` rather than defaulting. Requests are plain `GET` to
`https://online.mmvietnam.com/graphql` with only the `store` header — no cookies, no
`Authorization`. Each request has a 25 s deadline (`AbortSignal.timeout`) and its response
body is capped at 2 MiB while streaming. `mm_search_products` issues two such requests in
sequence, so its ceiling is roughly 50 s; `mm_get_product` issues one, so 25 s. A caller or
`harness that waits less than that can time out a request that is still legitimately in
flight — a harness limit, not a server failure. `spawnGate` waits 30 s per request by default
and accepts a named per-call bound (1…90 s) for exactly this reason: the cart write gate names
80 s for its one write call, every other call keeps 30 s.

### `mm_search_products`

| Argument | Rules | Default |
| --- | --- | --- |
| `query` | string, 1–100 chars, no control characters | required |
| `page_index` | integer 0–40 (upstream `currentPage = page_index + 1`) | `0` |
| `page_size` | one of `10`, `20`, `24`, `50` | `24` |

Runs the captured two-stage contract: `ProductSearch` (render_stage `CARD`) lists the
page, then `ProductSearchEnrich` (render_stage `ENRICH`) prices exactly the SKUs CARD
returned, joined by exact SKU, output in CARD order. Two sequential upstream requests, each
with its own 25 s deadline and 2 MiB cap — total wall clock up to roughly 50 s. Returns:

```
{ products: [{ id, sku, name, url_key, unit, quantity_step, stock_status,
               price_vnd, regular_price_vnd, promotion, member_offer }],
  pagination: { total_count, total_pages, page_index, page_size },
  context: { store_code, authenticated: false },
  price_status: "catalog-observed-not-guaranteed-payable",
  observed_at: "<ISO time of this read>" }
```

`quantity_step` is preserved exactly as upstream publishes it (fractions such as `0.5`
are legitimate ordering steps, not errors). `unit` is nullable upstream metadata: `null`
means "no unit label published" and is a valid answer (7 of the 11 rows in the real
`ức gà` answer, store `b2c_70010_vi`) — it is never invented as `Kg`/`Hộp`.
`price_vnd` and `regular_price_vnd` are two independently observed cells: they may be
equal, and `price_vnd` may sit ABOVE `regular_price_vnd` (live proof
`SKU351030_23510302`: final `55000`, regular `52000`, discount `0`). Nothing here asserts
a discount; both are VND integers, catalog-observed, not payable prices. `promotion` is a
label or `null`; `member_offer` is the raw MCard offer blob, never your payable price.
An empty page is a valid empty result and owes no enrichment.

### `mm_get_product`

| Argument | Rules | Default |
| --- | --- | --- |
| `url_key` | string, 1–200 chars, slug `[A-Za-z0-9._-]` starting alphanumeric; no slash, query/fragment or control characters | required |
| `expected_sku` | string, 1–64 chars, no control characters; take it from the same search page/store | none |

Runs the captured ProductPage query — `products(filter:{url_key:{eq:<url_key>}},
show_disabled:true)` — an exact lookup, not search. Exactly one product must come back:
zero is `PRODUCT_NOT_FOUND`, more than one is `MULTIPLE_PRODUCTS`. Identity rules:

- With `expected_sku`, the SKU binds the product. Upstream may serve a product under a
  different canonical slug than the search card showed; the call succeeds when the single
  answer's SKU equals `expected_sku`, and the `url_key` you get back is the upstream
  canonical one. A different SKU is `SKU_MISMATCH`.
- Without `expected_sku`, the returned `url_key` must equal the requested one exactly,
  otherwise `PRODUCT_NOT_FOUND`.
- There is no SKU-only lookup: a SKU on its own is not a valid argument, because the
  captured card path shows the `sku:{eq}` filter is ignored upstream.

Returns `{ product: { …same row keys… }, context, price_status, observed_at }`. Same row
contract as search: `unit` may be `null`, and `price_vnd` / `regular_price_vnd` are two
independently observed cells (`price_vnd` may exceed `regular_price_vnd`). Prices
are the guest view of the configured store: observed, not payable, and never member
pricing (this server has no authenticated catalog view at all).

## Authenticated read tools (`src/account.mjs`)

All five read the credential file, then make a live request per call. No caching, no
cached success. Two documents exist: `MMReadProof` (customer addresses page +
`storeConfig`) for status/context/addresses, and `MMCartRead` (`customerCart` +
`customer.__typename` + `storeConfig`) for the cart tools. Every answer is checked: the
reply really is a `Customer`, and `storeConfig.store_code` really equals the store in the
auth file (`STORE_MISMATCH` otherwise).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `mm_auth_status` | none | `{ authenticated: true, store_code, store_name, observed_at }` |
| `mm_get_delivery_context` | none | `{ store_code, store_name, address_selection: "NOT verified: …", observed_at }` |
| `mm_list_addresses` | `page_index` 0–40, `page_size` 1–20 (default 20) | `{ addresses: [{ id, default_shipping, city, street, custom_attributes }], pagination: { page_index, page_size, total_count, total_pages }, context, observed_at }` |
| `mm_get_cart` | none | `{ items: [{ uid, sku, name, quantity, price_vnd, row_total_vnd }], total_quantity, totals: { subtotal_excluding_tax_vnd, grand_total_vnd, currency: "VND" }, shipping: { address_count, selected_methods: [{ method_title, amount_vnd }], note }, price_status, context, observed_at }` |
| `mm_cart_summary` | none | `{ line_count, total_quantity, currency, subtotal_excluding_tax_vnd, grand_total_vnd, shipping, price_status, context, observed_at }` |

Things to read carefully in those shapes:

- `address_selection` says `NOT verified` — a saved `default_shipping` row is stored
  data, not the address currently selected at cart/checkout.
- `shipping` is a count plus method labels; street and city are withheld on purpose.
- `quantity` may be fractional (goods sold by weight); `total_quantity` is upstream's
  number, never a line count.
- `totals` are copied from upstream and never recomputed or reconciled against the lines;
  `line_count` is upstream rows counted here.
- An empty cart (`total_quantity: 0`, no lines) is a valid result; a missing cart is
  `REQUIRES_LOGIN`, never a fabricated empty one.
- Cart money cells must be non-negative, finite VND; anything else fails closed.

## Authenticated cart write tools (`src/cart.mjs`)

Three tools, and they are the only path in this server that changes anything upstream.
**Implemented and offline-tested with fakes; NOT live-verified** — no cart write has ever
reached `https://online.mmvietnam.com` from this repository. Run
`MM_MCP_LIVE=1 MM_CART_WRITE_APPROVED=i_understand_this_changes_the_cart MM_LIVE_SKU=<sku> MM_LIVE_QTY=<n> npm run live:cart`
to exercise one real add; until such a run reports an exact increment, every claim below is
contract + fake evidence. The one approved run so far (2026-11-01) was blocked before
dispatch: its pre-read answered `Syntax Error` (one missing brace, since fixed; the fixed
document is proven to parse by `npm run proof:cart`), so zero mutations were sent.

Every call follows the same sequence, in this order, and never out of it:

1. arguments checked strictly (`additionalProperties: false`, nothing unknown reaches the wire);
2. `confirm` gate — missing is `CONFIRM_REQUIRED`, anything other than exactly `true` is
   `NOT_CONFIRMED`; in both cases **zero** requests are made;
3. credential read (the same strict loader as `src/account.mjs`) — a local credential problem
   is `REQUIRES_LOGIN` with zero requests;
4. local intent guard: an identical intent already dispatched in this process is answered
   from the recorded report with zero new requests (local duplicate protection only — not
   backend exactly-once, a restart clears it and a browser can still double-add);
5. fresh owner-bound **pre-read** (`customerCart`);
6. validate against that pre-read, then dispatch **exactly ONE** mutation;
7. fresh owner-bound **post-read**, which is the only authority for the verdict;
8. report `applied` | `rejected` | `unknown`. Never retried, never compensated.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `mm_add_to_cart` | `sku`, `quantity` (> 0, fractional allowed), `confirm: true` | `{ verdict, mutation_count, intent, layout, quantity_observed, pre_state, post_state, cart_change_detected, errors, cart_id, price_status, next_step, observed_at }` |
| `mm_update_cart_item` | `item_uid`, `quantity` (> 0, fractional allowed), `confirm: true` | `{ verdict, mutation_count, intent, quantity_requested, quantity_pre, quantity_observed, matches_absolute, matches_delta, pre_state, post_state, cart_change_detected, errors, cart_id, price_status, next_step, observed_at }` |
| `mm_remove_cart_item` | `item_uid`, `confirm: true` | `{ verdict, mutation_count, intent, uid_present_post, pre_state, post_state, cart_change_detected, errors, cart_id, price_status, next_step, observed_at }` |

Things to read carefully in those shapes:

- There is **no cart id argument**. `cart_id` is *returned* as the fixed string
  `not exposed (owner-bound, resolved internally)`: the cart comes from the authenticated
  owner lookup, and a caller-supplied `cart_id`/`cartId` is refused `INVALID_ARGS`, never
  forwarded and never silently ignored.
- `verdict` has exactly three values, and the rule is deliberate:
  - `applied` — the backend complained about nothing **and** the post-read is consistent
    with the intent. Even then it means *consistent with*, not *caused by*: another client
    may have made the same change.
  - `rejected` — the backend errored **and** the observed cart is unchanged. Only a refusal
    the state corroborates is called a refusal.
  - `unknown` — everything else: a lost or timed-out answer, a clean answer with an
    unchanged cart, and errors **with** a changed cart. Errors plus movement cannot prove
    this intent failed (a partial landing — some units in, the rest refused — is a realistic
    answer), so that combination is `unknown`, never `rejected` and never a coined
    `applied_with_warnings`.
  `unknown` means the write may already have applied; this server never retries, because a
  retry of an unknown add is a possible double add.
- `mutation_count` is 0 for anything refused before dispatch and exactly 1 once dispatched.
- `updateCartItems` takes `cart_item_uid`, never `cart_item_id` (the wire documents copied
  verbatim into `src/cart.mjs` use the uid form; `cart_item_id` appears in no record).
- `matches_absolute` / `matches_delta` report which interpretation the observed quantity
  matches. Absolute-vs-delta is **UNVERIFIED**: the number is passed through unchanged, and
  if the post-read matches neither, the verdict is `unknown`.
- `layout` says `new_line (sku absent from pre)` or `same_or_merged (pre already had the
  sku)` — merge-vs-new-line is **UNVERIFIED**, so it is reported as observed, never predicted.
- Quantities may be fractional (goods sold by weight) and are passed through exactly: 1.5
  and 2.25 arrive as 1.5 and 2.25, never rounded or truncated. Quantity 0 is refused —
  removal is explicit (`mm_remove_cart_item`), never implied by a zero.
- No quantity constraint is invented or enforced here: step / min / max
  (`mm_qty_step`, `unit_ecom`, `mis_stock`) are UNVERIFIED, so an out-of-step or
  out-of-stock add is reported by backend errors, not predicted.
- `pre_state` / `post_state` are `{ observed_at, line_count, total_quantity, grand_total_vnd,
  lines }`; `line_count` counts rows and is never a quantity, `total_quantity` is upstream's
  own figure. Totals are copied, never recomputed (`price_status`).
- Address binding is still open: no `customer_address_id` / `city_code` / `ward_code` is
  available, so a write never claims which address it priced against.
- Wall clock: one write is three sequential requests (pre-read, mutation, post-read), each
  with its own 25 s deadline, so `mm_add_to_cart` can take up to roughly 75 s. A wrapper
  timeout of 30 s is too short; the live gate waits `CART_MUTATION_TIMEOUT` = 80 s for the
  write call and keeps 30 s for every other call (see [testing.md](testing.md)).

## Application-level error codes

| Code | From | Meaning |
| --- | --- | --- |
| `MISSING_STORE_ENV` | catalog | `MM_STORE_CODE` unset or empty; guest tools refuse to guess a store |
| `INVALID_STORE_CODE` | catalog | `MM_STORE_CODE` present but not `b2c_<1–8 digits>_vi` |
| `INVALID_ARGS` | catalog, account, cart | bad or unknown argument for the tool |
| `UNKNOWN_TOOL` | catalog, account, cart | tool name this module does not implement |
| `PRODUCT_NOT_FOUND` | catalog | no product for that exact `url_key` (or the answer's slug is not the one requested and no `expected_sku` was given) |
| `MULTIPLE_PRODUCTS` | catalog | an exact `url_key` answered with more than one product |
| `SKU_MISMATCH` | catalog | `expected_sku` does not equal the single answer's SKU |
| `ENRICHMENT_INCOMPLETE` | catalog | a SKU on the CARD page was not priced, was priced twice, or an unrequested SKU was priced |
| `PRICE_INVALID` | catalog | malformed money cell, or final price above regular price |
| `BAD_MONEY` | account, cart | cart money cell is not non-negative finite VND |
| `STORE_MISMATCH` | account | `storeConfig.store_code` disagrees with the store in the auth file |
| `REQUIRES_LOGIN` | account | credential missing/unreadable/insecure/invalid/expired, cart not found, or upstream answered an authentication-category error — the one code to act on |
| `BAD_UPSTREAM_DATA` | catalog, account, cart | a required field was missing, malformed, duplicated or out of range |
| `UPSTREAM_TIMEOUT` | catalog, account, cart | the 25 s per-request deadline fired |
| `UPSTREAM_UNREACHABLE` | catalog, account, cart | DNS/connect/TLS failure |
| `UPSTREAM_HTTP_STATUS` | catalog, account, cart | a non-2xx status that is not 401/403 (those are `REQUIRES_LOGIN` in the account module) |
| `RESPONSE_TOO_LARGE` | catalog, account, cart | declared or streamed body crossed 2 MiB |
| `RESPONSE_NOT_JSON` | catalog, account, cart | body was not parseable JSON or had no `data` object |
| `GRAPHQL_ERRORS` | catalog, account, cart | the answer carried GraphQL errors that were not authentication errors |
| `INTERNAL` | catalog, account, cart | an unrecognised failure; no detail is ever leaked |
| `CONFIRM_REQUIRED` | cart | `confirm` was not supplied at all: nothing was dispatched (the only code on a no-`confirm` call) |
| `NOT_CONFIRMED` | cart | `confirm` was supplied but is not exactly `true`: nothing was dispatched |
| `INTENT_IN_FLIGHT` | cart | an identical write is already being handled in this process: the second call dispatched nothing and did not wait for the first |
| `GUARD_FULL` | cart | all 64 intent-guard slots are in flight: the call dispatched nothing rather than running unguarded (local cap, in-process only) |
| `NOT_IN_CART` | cart | `item_uid` was not in the pre-read cart: nothing was dispatched, the current counts are named |

## Operator CLI outcomes (`scripts/auth-setup.mjs`)

Not MCP codes, and not reachable from MCP at all: the CLI is run by a human in a terminal,
it is the only path that writes (one `SignIn` mutation upstream plus one local credential
file). Plain words on stderr, exit 1. Success is `AUTH_SAVED` on stdout, exit 0 — a wrapper
around the CLI must propagate that exit code, not swallow it.

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | stdin was not exactly `{email, password, store}`, was over 16 KiB, timed out after 10 s, or command-line arguments were passed |
| `CONFIG_UNVERIFIED` | the reCAPTCHA form config could not be read or validated |
| `CHALLENGE_REQUIRED` | `CUSTOMER_LOGIN` is enabled; this CLI does not solve challenges |
| `LOGIN_REJECTED` | the sign-in mutation failed or returned an unusable token |
| `PROOF_FAILED` | a token came back but the customer/store proof did not hold |
| `STORAGE_UNSAFE` | the auth path has control characters, or some ancestor is missing / not a directory / a symlink, or the immediate parent is not owned by the running user or not mode 0700, or an existing target is not an owned mode-0600 regular file, or any of those identities changed before the rename |
| `STORAGE_FAILED` | the credential could not be written |
| `SETUP_FAILED` | anything unexpected |
