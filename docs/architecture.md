# Architecture, request flow and trust boundaries

Three modules make up the server; the rest of the repository is an operator CLI, the test
and live-gate harnesses, and these documents.

## Repository layout

```
src/server.mjs     JSON-RPC framing, MCP dispatch, stdio loop     (no direct network:
                                                                    catalog/account/cart do the fetches)
src/catalog.mjs    guest catalog: search (CARD -> ENRICH) + exact detail (network)
src/account.mjs    authenticated read: auth file + live proofs         (network)
src/cart.mjs       authenticated cart WRITE: pre-read -> one mutation -> post-read (network;
                   owns its own POST transport, reuses account.mjs's strict credential loader)
scripts/
  auth-setup.mjs          operator login CLI (the only thing that logs in; writes a token)
  account-live.mjs        live account gate  + the bounded stdio harness (spawnGate)
  catalog-live.mjs        live guest catalog gate (reuses spawnGate)
  cart-live.mjs           live cart WRITE gate (reuses spawnGate; needs explicit approval —
                          run once 2026-11-01, blocked at the pre-read, zero mutations)
  *.test.mjs              offline suites (canned payloads / local children, no real endpoint)
  consumer-acceptance.mjs consumer-level acceptance run (loopback fixture, or live read-only)
  cart_contract_extract.py  extractor behind the cart-write research (needs an external
                            capture directory; not runnable out of the box)
docs/              the pages you are reading
.github/workflows/test.yml  CI: node --check + npm test on Node 22 and 24 (the tested
                            matrix, not an exhaustive list of supported versions)
```

No dependencies. Native `fetch`, `node:fs`, `node:http`, `node:assert` only.

## Process and session model

One MCP session = one server process spawned by the client, connected by stdin/stdout.
The server does not fork, does not listen on a port, and does not multiplex clients. The
stdin loop keeps at most one open line, never more than 64 KiB of it, and answers each
complete line before reading further (`src/server.mjs:runStdio`).

Dispatch is stateful in exactly one bit (`state.initialized`), and dispatch is a pure
function of `(state, line)` — no `this`, no globals, no timers per session. Each method's
`params` is checked against a fixed key allowlist plus, separately, request-level `_meta`:
metadata must be an object when present (anything else is `-32602`), is never handed to a
tool, and is otherwise ignored. `id` must be a string or an integer — a fractional or
infinite numeric id is refused `-32600` with `id: null`.

## Guest request flow (`mm_search_products`)

```
client frame -> dispatch -> catalog.search
  1. check args (query / page_index / page_size)          -> INVALID_ARGS, no request
  2. read + check MM_STORE_CODE                           -> MISSING_STORE_ENV / INVALID_STORE_CODE
  3. GET /graphql  query ProductSearch        (CARD)      one request, one reply
  4. check page shape, collect exact SKUs in CARD order
  5. GET /graphql  query ProductSearchEnrich (ENRICH)     prices only those SKUs
  6. join by exact SKU, validate each price cell
  7. emit { products, pagination, context, price_status, observed_at }
```

Anything failing at steps 3–6 produces one fixed code and stops; a partial join is never
shown. Step 5 asks for exactly the SKUs from step 3, so no unpriced row can reach you and no
unrelated product can appear on the page. Steps 3 and 5 are two sequential upstream requests,
each under its own 25 s deadline: a legitimate search can take up to roughly 50 s, which is
more than the 30 s the bundled stdio harness (and many MCP clients) are willing to wait.

## Guest detail flow (`mm_get_product`)

One request: `products(filter:{url_key:{eq:…}}, show_disabled:true)`. Exactly one item
must come back; identity is bound either by `expected_sku` (which also lets upstream serve
a different canonical slug) or by exact `url_key` equality. This is why the tool is not a
search: the earlier attempt to reach detail through the search contract was replayed and
the `sku:{eq}` filter is ignored upstream — it returns the whole ~13k catalog.

## Authenticated request flow (the five account tools)

```
client frame -> dispatch -> account.callTool
  1. check tool name and arguments                        -> INVALID_ARGS, no request
  2. resolve auth path (MM_AUTH_FILE -> XDG_DATA_HOME -> ~/.local/share)
  3. validate and read the auth file                      -> REQUIRES_LOGIN, zero network
  4. GET /graphql with { Authorization, store }           -> one request, live proof
  5. prove: customer.__typename === "Customer"
             storeConfig.store_code === the store in the file
  6. validate every projected cell (shape, ids, quantities, money, labels)
  7. emit the projection with observed_at
```

The credential is read from disk on every call and never cached, so a re-login takes
effect on the next call without restarting the server. Local credential problems are
detected **before** any request is made — the server does not discover a bad credential by
failing a live call first.

## Cart write flow (the three `mm_*_cart*` write tools)

`src/cart.mjs` is the only place in this server that changes something upstream. Its shape is
deliberately different from the read flows: a read can be re-issued freely, a write cannot.

```
tools/call mm_add_to_cart { sku, quantity, confirm }
   1. check tool name + arguments (strict, additionalProperties false)  -> INVALID_ARGS, zero requests
      a cart id in any spelling (cart_id / cartId / ...) is refused here, never forwarded
   2. confirm gate: absent -> CONFIRM_REQUIRED, present-but-not-true -> NOT_CONFIRMED
      either way: zero requests                                            (nothing dispatched)
   3. credential via account.mjs's strict loader (reused, not re-implemented)
                                                                -> REQUIRES_LOGIN, zero requests
   4. intent guard (in-process Map, last 64 intents): identical intent already dispatched
      -> answer from the recorded report, zero requests       (local duplicate protection only)
   5. PRE-READ   customerCart (owner-bound)                    -> 1 request
   6. validate against that pre-read (uid must exist for update/remove)
   7. DISPATCH   exactly one mutation, one POST, 25 s deadline -> 1 request
   8. POST-READ  customerCart again, fresh                     -> 1 request
   9. verdict from the post-read only: applied | rejected | unknown, plus observed_state
```

- A mutation is never sent as GET, and never retried: an unknown outcome may already have
  applied, and a retry of an unknown add is a possible double add.
- There is no compensating/rollback mutation. If a write applied and the caller wants it
  undone, that is a separate, explicitly confirmed call.
- Absolute-vs-delta quantity, merge-vs-new-line, and quantity step/min/max are all
  UNVERIFIED against this endpoint: the number is passed through unchanged and the post-read
  says which shape was observed. No default constraint is invented.
- `cart_id` is resolved internally and never echoed: the report says
  `not exposed (owner-bound, resolved internally)`.
- Ceiling ≈75 s per call (three sequential requests, 25 s each) — a 30 s client timeout is
  too short for a write.
- **Nothing here is live-verified:** every `applied` in the test suite came from a fake
  transport. `scripts/cart-live.mjs` (gated, never run) is the only path to real evidence.

## Two contexts, never mixed

- Guest tools send no `Authorization` header and report `context.authenticated: false`.
- Account tools send `Authorization` + `store` and report `context.authenticated: true`.
- Guest prices never become account prices and vice versa: this server has no authenticated
  catalog view, so there is no silent fallback from one to the other.

## Trust boundaries

| Boundary | What the server checks | What it must accept from upstream |
| --- | --- | --- |
| Client → server (stdio) | framing, JSON validity, ≤64 KiB lines, fatal UTF-8 per line (bad bytes are a Parse error, never U+FFFD), exact `initialize`, known method, `id` is a string or an integer, params keys inside the per-method allowlist, request-level `_meta` must be an object when present (then ignored), argument types and bounds | nothing: an unchecked frame is refused |
| Server → GraphQL (guest) | one fixed origin, only the `store` header, 25 s deadline per request (search issues two in sequence, so up to ~50 s end to end), 2 MiB streamed-body cap per request, page shape, exact-SKU join, price cell validity, non-inverted prices | product data, prices, stock labels, promotion blobs — all reported as *observed* |
| Server → GraphQL (account read) | same origin/cap/per-request deadline, credential-file safety before the call, `Customer` proof and store cross-check after it, cart row/currency/quantity validity | cart lines, totals, addresses, store name — reported as *observed*, never recomputed |
| Server → GraphQL (cart write) | same origin/cap/per-request deadline, `confirm: true` required before anything is dispatched, credential checked locally first, exactly one mutation per call, never retried, verdict taken from a fresh post-read and never from the mutation's HTTP 200 | whether the mutation applied, whether it merged into an existing line, whether the quantity was read as absolute or delta, which address was priced — all *observed* or reported `unknown`; nothing here is live-verified |
| Credential file | regular file (not a symlink), owner = running user, mode exactly 0600, immediate parent a real (non-symlink) directory owned by the running user with no group/other access, ≤16 KiB, exactly two keys, bearer pattern, store pattern | that the token itself is valid or not — only upstream can say, and the server asks on every call |
| Out to the caller | one envelope per request, fixed codes, no upstream bodies | the projected numbers, which carry `price_status` / `NOT verified` markers so their status travels with them |

The checks stop at the immediate parent. `src/account.mjs` `lstat`s that one directory only —
existence, not a symlink, owned by the running user, no group/other bits (so `0700` or
stricter passes). `scripts/auth-setup.mjs` walks up to the filesystem root, but for ancestors
above the immediate parent it checks only "is a real directory" and "is not a symlink"; it
asserts ownership and mode exactly `0700` on the immediate parent alone. A group-writable
grandparent is accepted by both, so the path is private at the file and its own directory —
not proven private all the way to the root.

What is explicitly **not** trusted anywhere: caller-supplied cart or line identifiers (the
tools take none), upstream HTTP 200 as proof of success, cached data as proof of current
state, or a saved `default_shipping` flag as proof of the delivery address in use.

## Where secrets are, and where they never go

- The bearer token lives in one file, mode 0600, outside git (`.gitignore` covers
  `auth.json`, `**/token`, `**/tokens`, `**/*.token`, `**/session*.json`,
  `**/cookies*.json`).
- There is no logging in this server. Outside the protocol stream it writes one line,
  `fatal: <message>`, when the stdio loop itself fails. No tool result carries the
  credential: the projections return counts, rows, labels and totals only.
- The setup CLI never sees a bearer as input: stdin carries `{ email, password, store }`,
  and `Bearer <token>` is what the `SignIn` mutation returns. Nothing is accepted as a
  command-line argument, and no tool argument takes a token or a cart id.
- The acceptance harness writes a temporary owner-private synthetic credential in fixture
  mode (only the spawned child reads it) and opens no auth file in live mode — it inherits
  the environment and lets the server's own path resolution do the reading.
- Known residual risk: path checks made through path-based filesystem APIs are not a defense
  against another process running as the *same* OS user swapping paths mid-window. That gap
  is inherent to the API; nothing here claims otherwise.

## Limits by design

| Limit | Value | Where |
| --- | --- | --- |
| Transport | stdio only — no HTTP/SSE, no multi-client sessions, no mTLS | `src/server.mjs` |
| MCP surface | `initialize`, `ping`, `tools/list`, `tools/call`; no resources, prompts or logging | `src/server.mjs` |
| Protocol version | `2024-11-05`, fixed constant | `src/server.mjs` |
| Stdin line cap | 64 KiB, one Parse error then normal service | `src/server.mjs` |
| Upstream deadline | 25 s per request; `mm_search_products` issues two in sequence (≈50 s ceiling), every other tool one | `src/catalog.mjs`, `src/account.mjs` |
| Upstream body cap | 2 MiB, enforced while streaming, not after buffering | `src/catalog.mjs`, `src/account.mjs` |
| Catalog paging | 0-based `page_index` up to 40; `page_size` ∈ {10, 20, 24, 50} | `src/catalog.mjs` |
| Address paging | 0-based `page_index` up to 40; `page_size` 1–20 | `src/account.mjs` |
| Caching | none — every answer is a live read; the cart intent guard is not a cache, it holds the last 64 dispatched intents in process memory to answer a duplicate call without a second mutation, and a restart clears it | all three modules |
| Rate limiting / metrics | unimplemented | — |
| Writes, from MCP | three cart tools (`mm_add_to_cart` / `mm_update_cart_item` / `mm_remove_cart_item`), each gated on `confirm: true`, one mutation per call, never retried — **not live-verified**: every verdict so far comes from an injected fake. No address, session or cache mutation is exposed | `src/cart.mjs` |
| Writes, outside MCP | two paths only: `scripts/auth-setup.mjs` sends one `SignIn` mutation upstream and writes the local credential file; `scripts/cart-live.mjs` would send one real cart add, but only under four explicit environment variables — it has been run once (2026-11-01) and dispatched nothing, because its pre-read failed. Both operator-run, neither client-invocable | `scripts/auth-setup.mjs`, `scripts/cart-live.mjs` |
| `params._meta` | accepted on every method when it is an object, then ignored (never reaches a tool); a non-object `_meta` is `-32602`. Fixed on this pass, covered by `scripts/stdio.test.mjs` — no MCP client connection is certified | `src/server.mjs` |

## What would change this picture

Nothing here is a promise. If HTTP transport, caching, or an authenticated pricing view are
ever added, they come with their own evidence and their own gate. The cart-write side is now
shipped as three confirm-gated tools, but **unshipped in the evidence sense**: no cart write
has ever reached the real endpoint from this repository, so all three carry
`not live-verified` until `scripts/cart-live.mjs` is actually run. See
[cart-write-contract.md](cart-write-contract.md).
