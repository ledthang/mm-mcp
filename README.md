# mm-mcp

Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) for MM Mega Market Vietnam:
guest catalog search + an authenticated read-only slice (auth status, delivery context,
address book). Stdlib only + native `fetch`. No dependencies.

## Requirements

Node.js >= 22 (native `fetch`, `AbortSignal.timeout`, `ReadableStream`).

## Setup

```sh
npm test          # core protocol suite (24) + catalog suite (22) + account suite (25)
npm start         # MCP stdio server (stdio in/out)
MM_STORE_CODE=b2c_10010_vi node scripts/catalog-live.mjs   # live gate, real endpoint
```

`MM_STORE_CODE` is **required** and has no default. Format `^b2c_[0-9]{1,8}_vi$`
(e.g. `b2c_10010_vi`). Without it the tool fails `MISSING_STORE_ENV` and the live gate
refuses to run.

## Tools

Two separate contexts, four tools. Guest catalog and authenticated read never silently
swap: the catalog stays an explicit `MM_STORE_CODE` guest view — it never falls back to
authenticated pricing, and the account tools never leak into catalog results.

### Guest catalog (no auth)

- `mm_search_products(query, page_index?, page_size?)` — guest catalog search.
  - `query`: 1–100 chars, no control characters.
  - `page_index`: 0-based, 0..40 (upstream `currentPage = page_index + 1`).
  - `page_size`: one of 10, 20, 24, 50 (default 24).

Returns a projection per page: `{ products, pagination, context, price_status,
observed_at }`. Each product row: `{ id, sku, name, unit, quantity_step, stock_status,
price_vnd, regular_price_vnd, promotion, member_offer }`.

### Authenticated read (authenticated, private tool use)

Auth comes from the **auth file** — `MM_AUTH_FILE` env, default
`$XDG_DATA_HOME/mm-mcp/auth.json` (else `~/.local/share/mm-mcp/auth.json`). **There is
no login tool**: setup means exporting an existing private browser session
(`{ "authorization": "Bearer <token>", "store": "b2c_<digits>_vi" }`, chmod 600) to that
path yourself. The file is a **secret, kept outside git** — the server reads it per
call, validates it (regular file, not a symlink, owned by the running user, mode 600,
parent dir with no group/other access, ≤ 16 KiB), and **never prints or logs the
token**. Any credential problem is one actionable code: `REQUIRES_LOGIN`.

- `mm_auth_status()` — live proof per call: runs the proven `MMReadProof` query and
  returns `{ authenticated: true, store_code, store_name, observed_at }` only after the
  upstream actually shows a customer. No cached/stale success; missing or rejected
  credential is an error (`isError`, `REQUIRES_LOGIN`), never a fake `false` success.
- `mm_get_delivery_context()` — `{ store_code, store_name, address_selection,
  observed_at }` from `storeConfig`, cross-checked against the store in the auth file
  (`STORE_MISMATCH` fails closed). `address_selection` is explicitly **NOT verified**: a
  saved `default_shipping` address is stored data, never the delivery address currently
  selected at cart/checkout.
- `mm_list_addresses(page_index?, page_size?)` — saved address-book rows, live per
  call: `{ addresses, pagination, context, observed_at }`. Each row holds exactly
  `{ id, default_shipping, city, street, custom_attributes }` — no identity fields
  (email/name/phone), no orders. `page_index`: 0-based 0..40 (upstream
  `currentPage = page_index + 1`); `page_size`: 1..20 (default 20).

## Guarantees / out of contract

### Guest catalog view

- Prices are `catalog-observed-not-guaranteed-payable` — what the guest page shows, not
  a payable guarantee.
- `stock_status` is the upstream label (`IN_STOCK`/`OUT_OF_STOCK`), not an inventory
  count or purchasability guarantee.
- `member_offer` is the raw upstream MCard offer blob, never your payable price.
- Guest catalog requests carry no cookies and no auth header — plain `GET` to
  `https://online.mmvietnam.com/graphql` with only the `store` header.
- `mm_get_product` is intentionally **absent, not stubbed**: the proof path (CARD request
  with `filter: { sku: { eq: ... } }`, empty search) was replayed and the filter is
  ignored upstream — it returns the full ~13k catalog, first item unrelated. Search-by-sku
  would be search-as-detail, which is out of the captured contract.

### Both contexts

There is **no cart and no address-selection tool** anywhere: nothing in this server
mutates anything upstream (read-only). The authenticated tools are read-only views for
private use; `default_shipping` is never presented as the currently selected delivery
address. There is **no login tool** — the credential is an exported private browser
session placed in the auth file by the operator.

## Transport notes

- Bytes split on byte 10; utf8 decoding only once a line is complete (multibyte chars
  split across chunks survive). Lines over 64 KiB are never dispatched — exactly one
  Parse error, then service resumes.
- One reply per request line, written and awaited before the next bytes are read
  (backpressure; no promise queue). Notifications get no reply.
- One complete stage = `ProductSearch` (CARD) then `ProductSearchEnrich` (ENRICH) over
  the exact SKUs CARD returned, joined by exact SKU. Missing/duplicate/unrequested
  enrichment fails closed; no unpriced row is ever emitted.
- Upstream calls: fixed origin, 25 s timeout, response body capped at 2 MiB while
  streaming. Errors are sanitized to fixed codes; raw upstream bodies never reach the
  caller.
