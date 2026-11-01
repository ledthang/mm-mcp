# mm-mcp

Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) for MM Mega Market Vietnam:
guest catalog search + an authenticated read-only slice (auth status, delivery context,
address book). Stdlib only + native `fetch`. No dependencies.

## Requirements

Node.js >= 22 (native `fetch`, `AbortSignal.timeout`, `ReadableStream`). CI runs the
Node **22 and 24** matrix (`.github/workflows/test.yml`); nothing else is claimed as
tested. No dependencies to install — stdlib only, so CI has no `npm install` step.

## Commands — offline suite vs live gates

`npm test` is **offline and deterministic**: it makes no request to the real endpoint,
needs no credential and no network. The two anonymous live parse replays are opt-in and
live behind `MM_LIVE_PARSE=1`, which the `npm test` script clears explicitly; they are
reported as `SKIP`, never as a pass, so the offline count never includes network cases.

```sh
npm test            # offline: auth setup 74 + existing 103 checks, 2 live-only SKIP
npm run auth:setup  # operator login: bounded JSON stdin, real endpoint; see setup below
npm start           # MCP stdio server (stdio in/out)
npm run live:parse  # account suite with the 2 live gates enabled: 33 offline + 2 anonymous PARSE replays
npm run live        # explicit live catalog gate: needs MM_STORE_CODE, real endpoint
MM_STORE_CODE=b2c_10010_vi npm run live:account  # live account gate: real credential + real endpoint, 19 checks
```

- `npm test` expects `74/74` fake-only auth setup checks, then existing summaries:
  `24/24`, `40/40`, `33/33 checks passed,
  2 live-only skipped (…)`, then `6/6 gate harness tests passed` (the
  `account-live.test.mjs` suite exercises the live-gate harness against **fake** children
  only — no real endpoint, no credential). The 2 skipped checks are labelled
  `SKIP`, **not** counted as run; offline coverage totals 177 checks. The account
  suite alone reaches `35/35` only with `npm run live:parse`.
- `npm run live:parse` hits `https://online.mmvietnam.com/graphql` **anonymously** — no
  `Authorization` header, the auth file is never read. It only asserts the shipped query
  text PARSES (no `Syntax Error`); an `AUTHENTICATION`-shaped or HTTP 403 answer is
  acceptable and is reported as `HTTP <status>, errors=<n>`. A transport failure prints
  `SKIP … (live attempt failed: <error>)`, counts as **NOT verified** and exits 1 —
  never as a pass, never folded into the passed count.
- `MM_STORE_CODE` (catalog live gate) is **required** and has no default. Format
  `^b2c_[0-9]{1,8}_vi$` (e.g. `b2c_10010_vi`). Without it the tool fails
  `MISSING_STORE_ENV` and the live gate refuses to run.
- `npm run live:account` is the **live account gate** (`scripts/account-live.mjs`): two
  children, run one at a time. **S1** gets `MM_AUTH_FILE` pointed at a nonexistent path
  — no credential exists for it, every authenticated call must answer
  `REQUIRES_LOGIN` (fixed code, fast, no live credential needed). **S2** runs with the
  **inherited environment** — the real credential is read by the child's account module
  from the auth file, per call; the gate itself never opens `auth.json`, never prints
  the token, and prints only safe facts (booleans / counts / store code), never
  addresses, items, stderr content or raw replies. S2: initialize properly → one
  `tools/list` → one live call per tool (both guest tools, then all five authenticated
  tools), each reply validated as a strict envelope matched by exact id; a notification
  owes no reply. Every wait is bounded: one request → at most one reply with a 30 s
  per-request timeout (the server caps one upstream call at 25 s); retained stdout is
  capped at 2 MiB per pending line (over the cap the answer is `LOCAL_LIMIT` and the
  child is SIGKILLed — any legitimate envelope here is far below 2 MiB); a child
  `close`/`error` or failed stdin write resolves the outstanding waiter immediately;
  `close()` ends stdin, waits a 5 s grace, then SIGKILLs an uncooperative child
  (already-closed resolves immediately) and a process `exit` hook kills any survivor.
  Unsolicited/duplicate frames are counted (`orphan_frames`), never silently dropped.
  Last run: **19/19 checks passed** (8×S1, 11×S2). Failure path checked:
  with `MM_AUTH_FILE=/nonexistent/dir/auth.json` the gate printed the same
  safe-fact lines (S2 auth checks FAIL) and **exited 1** — no raw data, no token.

## Tools

Two separate contexts, seven tools (2 guest + 5 authenticated). Guest catalog and
authenticated read never silently swap: the catalog stays an explicit `MM_STORE_CODE`
guest view — it never falls back to authenticated pricing, and the account tools never
leak into catalog results.

### Guest catalog (no auth)

- `mm_search_products(query, page_index?, page_size?)` — guest catalog search.
  - `query`: 1–100 chars, no control characters.
  - `page_index`: 0-based, 0..40 (upstream `currentPage = page_index + 1`).
  - `page_size`: one of 10, 20, 24, 50 (default 24).

Returns a projection per page: `{ products, pagination, context, price_status,
observed_at }`. Each product row: `{ id, sku, url_key, name, unit, quantity_step, stock_status,
price_vnd, regular_price_vnd, promotion, member_offer }`.

- `mm_get_product(url_key, expected_sku?)` — **exact guest URL-key lookup**, not search.
  Runs a query derived from the ProductPage capture, with an explicit top-level
  `price_range.maximum_price.regular_price` selection added. The projected regular price
  still comes from `price.regularPrice.amount`:
  `products(filter:{url_key:{eq:<url_key>}},
  show_disabled:true)` — one exact `url_key` (slug: `[A-Za-z0-9._-]`, no slash, query
  or fragment chars) in, **exactly one** product out, or a fixed failure
  (`PRODUCT_NOT_FOUND` / `SKU_MISMATCH` / `INVALID_ARGS` …). `expected_sku`, if given,
  must equal the matched product's SKU (fails closed otherwise).
  - Example: `mm_get_product(url_key="trung-ga-tuoi-cp-hop-10-qua-120167")` →
    the exact egg product (`sku 120167_21201677`); with
    `expected_sku="99999_99999"` it fails `SKU_MISMATCH`, never shows a wrong product.
  - **Same-store search → detail**: take `url_key` **and** `sku` from one
    `mm_search_products` row (same store, that page) and call
    `mm_get_product(url_key=<row.url_key>, expected_sku=<row.sku>)` in that same store. Upstream may serve the
    product under a different canonical slug than the card showed, so `expected_sku`
    is what binds identity — the call succeeds if the single answer's SKU matches,
    even under another slug. Returned detail `product.url_key` is the upstream
    canonical slug, not necessarily the search alias. Without `expected_sku` the returned `url_key` must equal
    the requested one exactly (strict: no guessing, `PRODUCT_NOT_FOUND` otherwise).
  - **No SKU-only lookup**: this tool asks by `url_key`, not by SKU — an SKU alone is
    not a valid argument (`INVALID_ARGS`), and search-by-sku would be search-as-detail,
    which the captured contract rules out (the CARD `sku:{eq}` filter is ignored
    upstream).
  - **Guest detail, not account pricing**: prices are the guest view of the store in
    `MM_STORE_CODE` — `catalog-observed-not-guaranteed-payable`, no member/account
    pricing of any kind (the server has no authenticated catalog view at all).

### Authenticated read (authenticated, private tool use)

Auth comes from the **auth file** — `MM_AUTH_FILE` env, default
`$XDG_DATA_HOME/mm-mcp/auth.json` (else `~/.local/share/mm-mcp/auth.json`). **There is
no MCP login tool**: operator setup uses the separate `npm run auth:setup` CLI
to save `{ "authorization": "Bearer <token>", "store": "b2c_<digits>_vi" }` (mode 600) to that
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
- `mm_get_cart()` — **takes no arguments** (no cart id: `customerCart` is the
  authenticated owner's cart, and no cart id is fetched or returned). Live per call:
  `{ items, total_quantity, totals, shipping, price_status, context, observed_at }`.
  Each line: `{ uid, sku, name, quantity, price_vnd, row_total_vnd }`; `quantity` may be
  a decimal (goods sold by weight). `totals` = `{ subtotal_excluding_tax_vnd,
  grand_total_vnd, currency: "VND" }` — **upstream-observed, never recalculated here,
  never a payable guarantee**. `shipping` = address **count** + selected method labels and
  amounts; street/city are withheld and the delivery address currently selected is **not**
  verified. Fail closed on any non-VND currency, a malformed row or a non-positive
  quantity (`BAD_MONEY` / `BAD_UPSTREAM_DATA`); a real empty cart is a valid empty result,
  while a missing cart is `REQUIRES_LOGIN`.
- `mm_cart_summary()` — **takes no arguments**; compact counts-only view: `{ line_count,
  total_quantity, currency, subtotal_excluding_tax_vnd, grand_total_vnd, shipping,
  price_status, context, observed_at }`. No line rows (use `mm_get_cart`), no cart id.
  `line_count` counts upstream rows; `grand_total` is copied from upstream and **not**
  reconciled against the lines.

`customer{__typename}` and `storeConfig` are requested in the cart document too, so every
cart answer is checked against the same two proofs as `mm_auth_status`: the reply really is
a `Customer` and `store_code` really equals the store in the auth file
(`STORE_MISMATCH`/`REQUIRES_LOGIN` otherwise).

### Auth file: operator setup and manual re-login

`npm run auth:setup` is a separate operator CLI, **not an MCP login tool**. It reads
one JSON object from stdin with exactly `email`, `password`, and `store` string keys.
No arguments are accepted. Passwords are never saved; stdout reports only `AUTH_SAVED`.
Input and each response are limited to 16 KiB; stdin and each request have a 10-second
deadline. Store must match `b2c_<1–8 digits>_vi`; control characters are rejected.

Use a trusted secret provider that emits JSON directly to stdin. For interactive
setup, this optional Python stdlib wrapper collects hidden terminal prompts before
starting the CLI, then sends escaped JSON directly to its stdin. No credential
appears in argv, shell history, or stdout, and prompt time does not consume the
CLI's stdin deadline:

```sh
python3 - <<'PY'
import getpass
import json
import subprocess

credentials = {key: getpass.getpass(key + ": ") for key in ("email", "password", "store")}
subprocess.run(["npm", "run", "--silent", "auth:setup"], input=json.dumps(credentials), text=True, check=True)
PY
```

Do not paste passwords/tokens into chat, command arguments, or shell literals.
Do not enable shell tracing or log secret-provider output. Python is only needed
for this example; the CLI itself uses Node stdlib only.

The CLI sends requests only to `https://online.mmvietnam.com/graphql`, with the
selected Store header and no cookies. First it reads `recaptchaV3Config` website key
and forms. Enabled `CUSTOMER_LOGIN` stops with `CHALLENGE_REQUIRED`; unknown,
malformed, or failed config stops with `CONFIG_UNVERIFIED`. Neither case attempts
login or bypass. Otherwise it sends exactly one `SignIn` mutation, with no bearer
header, then proves `customer.__typename === "Customer"` and the same
`storeConfig.store_code` using the returned Bearer. No retry, browser, cart
creation/merge, auth-session issuance, cookie storage, or refresh occurs.

Path precedence: `MM_AUTH_FILE`, then `$XDG_DATA_HOME/mm-mcp/auth.json`, then
`~/.local/share/mm-mcp/auth.json`. The CLI creates missing directories privately,
requires an owned mode-0700 immediate parent and owned mode-0600 regular existing
target, and rejects symlinks at every ancestor and target. It writes only
`{ "authorization": "Bearer <token>", "store": "b2c_<digits>_vi" }` through a synced
mode-0600 temporary file and atomic rename. Unsafe existing permissions are rejected,
not silently repaired. Failed login/proof/write leaves old auth untouched; errors
contain fixed codes only, never upstream messages, paths, or secrets. Keep auth
outside git. Use private directories under trusted filesystem ancestors; this is
not a defense against another process running as your own OS user swapping paths.

**Expiry recovery remains manual:** on `REQUIRES_LOGIN`, rerun this operator CLI,
then verify with `mm_auth_status`. The server re-reads and re-proves each call;
no restart is needed. If a challenge is required, use the supported first-party
flow; this CLI does not solve challenges. **Automatic refresh is not implemented.**
The [auth contract](docs/auth-lifecycle-contract.md) records the supplied primary
observation and limits: CAPTCHA can change, MFA policy is not established, and no
expiry-unit or automatic-renewal guarantee is claimed.

## Guarantees / out of contract

### Both contexts: READ ONLY

Nothing in this server mutates anything upstream — every tool is a read. There is **no**
`cart/add`/`cart/update`/`cart/remove` tool and **no address-selection tool**, so a cart
line or a selected address can never be changed through this server.

### Guest catalog view

- Prices are `catalog-observed-not-guaranteed-payable` — what the guest page shows, not
  a payable guarantee.
- `stock_status` is the upstream label (`IN_STOCK`/`OUT_OF_STOCK`), not an inventory
  count or purchasability guarantee.
- `quantity_step` is a positive finite number in both search and detail, preserved
  unchanged from numeric `mm_qty_step` (including `0.5`). No coercion, default,
  rounding or mass conversion; step is not package weight. Missing, null, string,
  boolean, non-finite, zero or negative steps fail `BAD_UPSTREAM_DATA`. Prices remain
  non-negative safe-integer VND under the existing price contract.
- `member_offer` is the raw upstream MCard offer blob, never your payable price.
- Guest catalog requests carry no cookies and no auth header — plain `GET` to
  `https://online.mmvietnam.com/graphql` with only the `store` header.
- `mm_get_product` is **exact URL-key lookup, not search**: `filter: { url_key: { eq: … } }`
  returns exactly one product (or `PRODUCT_NOT_FOUND`). The sku-filter path was replayed
  and ignored upstream (returns the full ~13k catalog), so there is **no SKU-only lookup**
  and search-by-sku would be search-as-detail — out of the captured contract. Prices in
  the detail view are the **guest** view of `MM_STORE_CODE`, not account pricing.

### Authenticated read / cart

The authenticated tools are read-only views for private use. `default_shipping` is never
presented as the currently selected delivery address, and the cart's `shipping` block never
claims selection was verified either. There is **no MCP login tool** — the operator
uses the separate setup CLI to place a proven credential in the auth file.

**No UI parity claim**: `/checkout/cart/` was observed rendering a fallback/empty-looking
view while the native `customerCart` query returns a real cart with lines. The cart tools
report what the authenticated GraphQL answer holds; they say nothing about what the browser
page displays, and nothing here proves a selected delivery address in that UI.

## Current scope and production gaps (honest)

**Shipped, read-only.** Seven tools: one guest catalog search, one guest URL-key detail,
five authenticated read views (auth status, delivery context, saved addresses, cart, cart
summary). Every call is a GET to one fixed origin; nothing in this server mutates anything
upstream.

**Verified and how:**
- `npm test` (offline, deterministic): 177 checks — auth setup 74, protocol framing 24,
  catalog mapping 40, account/cart projection 33, live-gate harness 6 (fake children). Deterministic means no
  network, no credential, fixed fixtures, and the same counts on every run; CI runs this
  on Node 22 and 24. Primary host verification: **177/177 passed**, with two
  live-only parse checks skipped. Restricted executor child-process failures
  (`EPERM`) did not reproduce on the host. The setup CLI also completed one
  authorized live login into a disposable private auth file; the existing account
  module verified that credential and store before the file was removed.
- `npm run live:parse`: 2 checks, anonymous HTTP, asserts only that both shipped query
  documents PARSE against the real endpoint. Last run: both PARSED (HTTP 403, 1
  authentication-shaped error each — expected for an anonymous call, not a syntax failure).
- `npm run live` (catalog): needs `MM_STORE_CODE`, hits the real endpoint, prints a snapshot.
- `MM_STORE_CODE=b2c_10010_vi npm run live:account` (account, operator-local only — needs
  a real credential in the auth file, so it is **not** in CI): 19 checks across the two
  children described above. Last run: **19/19** (S1 absent-auth 8/8; S2 guest + all five
  authenticated tools 11/11, cart observed with live lines, store consistent,
  `line_count`-based — no exact cart equality claimed). Missing-credential failure path:
  `MM_AUTH_FILE` nonexistent → 5 FAILs + exit 1, safe-fact output only, no token leak.

**Open gaps — no production-readiness claim:**
- **No live authenticated cycle in CI.** Nothing proves a real logged-in cart read in an
  automated run; CI has no credential by design. Local operator runs only.
- **No automatic token refresh.** Separate operator CLI supports setup/manual re-login;
  expiry is detected per call as `REQUIRES_LOGIN`. No cookies are persisted.
- **No cart writes** (`add`/`update`/`remove`) and **no address-selection tool**, so no
  checkout path exists here at all.
- **`mm_get_product` needs the exact `url_key`** (captured ProductPage contract: one
  `url_key` in, one product out). No SKU-only lookup — the sku-filter path is ignored
  upstream (returns the full ~13k catalog), so guessing a slug or SKU is not a lookup.
- **No authenticated-pricing view** distinct from the guest view; guest prices are
  `catalog-observed-not-guaranteed-payable`.
- **No UI parity claim**: the browser `/checkout/cart/` route was seen rendering a
  fallback/empty view while `customerCart` returned real lines; this server reports the
  GraphQL answer only.
- **stdio only** — HTTP/SSE transports, multi-client session handling, caching, rate
  limiting and metrics are unimplemented and unclaimed.
- No browser/profile automation from the server: it never opens a browser or reads a
  browser profile; the credential is handed to it as a file.

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
