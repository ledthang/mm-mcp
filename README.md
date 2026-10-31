# mm-mcp

Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) for MM Mega Market Vietnam
catalog search. Stdlib only + native `fetch`. No dependencies.

## Requirements

Node.js >= 22 (native `fetch`, `AbortSignal.timeout`, `ReadableStream`).

## Setup

```sh
npm test          # core protocol suite (24) + catalog suite (22), no network
npm start         # MCP stdio server (stdio in/out)
MM_STORE_CODE=b2c_10010_vi node scripts/catalog-live.mjs   # live gate, real endpoint
```

`MM_STORE_CODE` is **required** and has no default. Format `^b2c_[0-9]{1,8}_vi$`
(e.g. `b2c_10010_vi`). Without it the tool fails `MISSING_STORE_ENV` and the live gate
refuses to run.

## Tools

One tool only:

- `mm_search_products(query, page_index?, page_size?)` — guest catalog search.
  - `query`: 1–100 chars, no control characters.
  - `page_index`: 0-based, 0..40 (upstream `currentPage = page_index + 1`).
  - `page_size`: one of 10, 20, 24, 50 (default 24).

Returns a projection per page: `{ products, pagination, context, price_status,
observed_at }`. Each product row: `{ id, sku, name, unit, quantity_step, stock_status,
price_vnd, regular_price_vnd, promotion, member_offer }`.

## Guest-only

This is an **unauthenticated (guest) view** of one explicit store. There is **no login,
no detail tool, no cart**:

- Prices are `catalog-observed-not-guaranteed-payable` — what the guest page shows, not
  a payable guarantee.
- `stock_status` is the upstream label (`IN_STOCK`/`OUT_OF_STOCK`), not an inventory
  count or purchasability guarantee.
- `member_offer` is the raw upstream MCard offer blob, never your payable price.
- No account data exists here: the server holds no cookies, no auth header — each request
  is a plain `GET` to `https://online.mmvietnam.com/graphql` with only the `store` header.
- `mm_get_product` is intentionally **absent, not stubbed**: the proof path (CARD request
  with `filter: { sku: { eq: ... } }`, empty search) was replayed and the filter is
  ignored upstream — it returns the full ~13k catalog, first item unrelated. Search-by-sku
  would be search-as-detail, which is out of the captured contract.

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
