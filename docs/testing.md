# Testing and verification

What exists, how to run it, and what PASS / SKIP / FAIL actually mean here.

## The suites

`npm test` (`package.json` → `scripts`) chains eight suites with `&&`, so the chain stops on
the first failure. There is no combined summary — each suite prints its own.

| # | Suite | Runs | What it covers |
| --- | --- | --- | --- |
| 1 | `scripts/auth-setup.test.mjs` | offline | the operator setup CLI: 74 checks (fake fetch), printed as one summary line |
| 2 | `scripts/stdio.test.mjs` | offline | the MCP layer: framing, initialize/tools/call, bad input, auth-failure wiring, boundary math, `_meta`, ids, fatal utf-8 (37) |
| 3 | `scripts/catalog.test.mjs` | offline | the guest tools: search + detail against canned upstream payloads (45) |
| 4 | `scripts/account.test.mjs` | offline | the authenticated tools against canned/fake upstream payloads (33), plus 2 live-parse checks that SKIP |
| 5 | `scripts/account-live.test.mjs` | offline | account live runner against fake transports; no credential present; the per-call timeout bound (9) |
| 6 | `scripts/catalog-live.test.mjs` | offline | catalog live runner against fake transports; no credential needed. Includes the price contract (final above regular is upstream data, accepted; negative / fractional / currency-string prices caught) and the nullable `unit` contract (29) |
| 7 | `scripts/cart.test.mjs` | offline | the three cart write tools against an injected fake transport: argument strictness, the confirm gate, pre-read → exactly one mutation → post-read, verdicts (including errors-with-a-changed-cart, which is never a proven refusal), intent guard (including concurrency and the bound), credential-rotation identity, wire shape, secret redaction, brace/structure of the shipped GraphQL documents (28) |
| 8 | `scripts/cart-live.test.mjs` | offline | the cart WRITE live gate run against FAKE children only: approvals refuse before any child exists (empty call log), the applied claim is checked against the **observed increment** (an unchanged non-empty cart fails), confounded/partial/over increments fail, a refused or lost pre-read spends no mutation, dispatch accounting separates a pre-dispatch refusal from a guard replay and from a lost answer, and the gate asks for the write at most once (20) |

Verified 2026-11-01 under synthetic HOME/XDG: **275 PASS, 2 SKIP**, exit 0 (74
auth + 37 stdio + 45 catalog + 33 account + 9 harness + 29 catalog live runner +
28 cart + 20 cart write gate vs fake children).
The CI matrix is Node 22 and 24, not an exhaustive list of supported versions.
The scripts are the authoritative source for current counts.

**What "offline" means here:** every one of these eight suites answers from canned responses or
from a local child process, so nothing contacts `https://online.mmvietnam.com` and no
external network is used. That is not the same as "no sockets": suite 2 spawns the real
`src/server.mjs` over real stdio pipes, and suites 5, 6 and 8 spawn local *fake* children
while suite 7 uses an injected fake transport. The separate
`scripts/consumer-acceptance.mjs` runner spawns the real server **and** binds a real loopback
HTTP fixture on `127.0.0.1`. Say "no real endpoint / no external network", not "no network
at all".

Suite 7 is the cart suite and suite 8 tests the gate that would prove the cart writes; both
are **fake-only**: an `applied` verdict there means the injected fake answered in a way
consistent with the intent. It is not evidence that the store accepted a write. No cart write
has ever reached the real endpoint from this repository — see the `cart write` gate below.

## Run it

```sh
npm test            # the whole chain — no real endpoint, no credential, no external network
```

A clean way to run it on a machine you do not want touched, with its own `HOME` so no real
credential can be picked up:

```sh
ISO="/tmp/mm-test-$$"
mkdir -p "$ISO"
HOME="$ISO" XDG_DATA_HOME="$ISO" XDG_CONFIG_HOME="$ISO" PATH=/usr/local/bin:/usr/bin:/bin timeout 300 npm test
```

Expect each suite's own `N/N checks passed` (or `N/N tests passed`) line, the account suite
showing `33/33 checks passed, 2 live-only skipped`, the cart suite showing `28/28 checks
passed`, the cart write gate suite showing `20/20 checks passed`, and exit status 0.

There is no `test/` directory — every test file sits in `scripts/`.

## The two kinds of check — this distinction matters

- **PASS** — a check ran and its assertion held.
- **SKIP** — a check that could not run in this configuration. It is **not** a pass, and it
  is not a failure either. It means "no request was made, so nothing was proven." Every SKIP
  line in this repo says so in its own text.

A check that never ran must never be counted as passed. That rule is what the SKIP rows above
exist to protect.

## Request metadata (`params._meta`): fixed locally, no client certified

`src/server.mjs` used to allowlist `params` keys per method and omit `_meta` everywhere
(`INIT_KEYS`, `LIST_KEYS`, `CALL_KEYS`; `ping` took no params at all). A client that attached
`params._meta` got `-32602 Invalid params`, and when that happened on `initialize` the
session never opened — every later request then answered `-32600 not initialized`.

Now (2026-11-01, runtime changed on this pass): `_meta` is validated apart from the method
arguments on all four methods — accepted when it is an object, then ignored; a non-object
`_meta` is still `-32602`. `scripts/stdio.test.mjs` covers it (37 checks, all passing).

Same pipe as before, no external network (run from the repo root; the child is spawned
locally and never reaches the real endpoint):

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"probe","version":"1"},"capabilities":{},"_meta":{"trace":"x"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node src/server.mjs
# -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{...},"capabilities":{"tools":{}}}}
#    {"jsonrpc":"2.0","id":2,"result":{"tools":[ ...ten tools... ]}}
```

**What that does not prove:** the configured Hermes session. MCP Python SDK 2.0.0 is
installed in the Hermes venv (`~/.hermes/hermes-agent/venv`), and `python -B
~/.hermes/workspace/mm-sdk-check.py` ran initialize / tools/list / tools/call against this
server with PASS, `protocolVersion` `2024-11-05`, 7 tools and no upstream calls — but no
Hermes configuration was loaded and no Hermes session was opened, so Hermes is **not**
certified. `python3 -m pip show mcp` printing `WARNING: Package(s) not found: mcp` refers to
the system interpreter only and does not bear on the venv. The old "a live Hermes connection
fails" note predates this fix. Verify a real client connection before calling this closed.
That SDK run listed 7 tools: it predates the three cart write tools and has not been
repeated, so the cart tools have no SDK evidence either.

## Timing ceilings (relevant to any client or harness)

- Each upstream request has a 25 s deadline (`TIMEOUT_MS`), and no more than one request is in
  flight at a time.
- `mm_search_products` issues two sequential requests (CARD, then ENRICH) → ceiling ≈50 s.
  Every read tool issues one → ceiling 25 s.
- The three cart write tools issue **three** sequential requests (pre-read, one mutation,
  post-read) → ceiling ≈75 s. A wrapper timeout of 30 s cannot see a slow-but-valid write
  complete; set it above ~80 s. The verdict still comes only from the post-read: a timeout on
  the mutation leg is reported `unknown`, never retried.
- The bundled stdio harness (`spawnGate` in `scripts/account-live.mjs`, reused by
  `scripts/catalog-live.mjs` and `scripts/cart-live.mjs`) waits `CALL_TIMEOUT` = 30 s per
  request unless the caller names a bound: `ask(id, method, params[, timeoutMs])` accepts
  1…`MAX_CALL_TIMEOUT` (90 s) and falls back to `CALL_TIMEOUT` for anything else, so a bad
  timeout is never "wait forever". `scripts/cart-live.mjs` names `CART_MUTATION_TIMEOUT`
  = 80 s for the write call (above the ≈75 s composite ceiling, with 5 s slack) and keeps the
  30 s default for initialize, `tools/list` and the two reads. For a slow *search* the 30 s
  default is shorter than the ≈50 s ceiling, so a valid search can be reported as a timeout:
  a harness limit, not a server failure. Raise the wrapper/client timeout above ~50 s if
  search latency matters, or keep 30 s and treat those timeouts as inconclusive.

## The live gates

Everything that touches the real endpoint, and only what you opt into:

| Gate | Command | Auth | What it proves | What it does NOT prove |
| --- | --- | --- | --- | --- |
| anonymous parse | `npm run live:parse` | none | the shipped search queries still PARSE against the live site (no SyntaxError) | that any item is in stock, priced right, or payable |
| guest live | `MM_STORE_CODE=<code> npm run live` | none | real catalog search/detail at your store, with real prices | anything about your account |
| account live | `MM_STORE_CODE=<code> npm run live:account` | a real credential (operator-local) | a real end-to-end cycle: login → status → delivery context → addresses → cart, against real data | cart writes (that gate is read-only; see the cart write gate below), checkout |
| cart write | `MM_MCP_LIVE=1 MM_CART_WRITE_APPROVED=i_understand_this_changes_the_cart MM_LIVE_SKU=<sku> MM_LIVE_QTY=<n> npm run live:cart` | a real credential (operator-local), four variables required | ONE real `mm_add_to_cart` against your cart, with the pre-read and post-read around it | that update/remove work (they are not run), checkout, anything about another store |
| cart parse proof | `npm run proof:cart` | none (anonymous, read-only) | the two shipped cart READ documents PARSE against the live site (3 anonymous requests, one of them a negative control) | that any cart was read or written, that anything is payable; the three MUTATION documents are NOT sent here — dispatching one would be a write |
| consumer acceptance, fixture | `node scripts/consumer-acceptance.mjs` | none (synthetic) | a real MCP client drives the real server end-to-end over stdio against a loopback fixture | anything about real MM data — every value is synthetic |
| consumer acceptance, live | `node scripts/consumer-acceptance.mjs --live-readonly` | a real credential + `MM_STORE_CODE` | the same client walk against real store data | cart writes (the walk is read-only) |

The cart write gate is the only gate that changes anything, and it refuses to start without
all four variables: without them it prints `{"status":"blocked", …}` and makes zero requests.
It adds one line to your cart and never removes it again — there is no automatic cleanup,
because a cleanup would be a second mutation you did not approve. Its logic is exercised
offline by `scripts/cart-live.test.mjs` (FAKE children: the refusals, the observed-increment
check, the lost-answer case).

**Live status 2026-11-01: NOT VERIFIED.** The gate has been run once, with approval. It spent
**zero mutations**: the pre-read answered `HTTP 400 Syntax Error: Expected Name, found <EOF>`
because `CART_SNAPSHOT_QUERY` was missing one closing brace. The query is fixed (brace balance
now checked offline in the cart suite, and proven against the live parser by
`npm run proof:cart`: 3/3, anonymous, no cart touched). Nothing has been written, so no claim
about the cart tools is verified: everything known about them comes from
`scripts/cart.test.mjs` and `scripts/cart-live.test.mjs` (both fakes), the anonymous parse
proof, and [cart-write-contract.md](cart-write-contract.md) (wire evidence from the site's own
JavaScript).

`scripts/consumer-acceptance.mjs` is **not** part of `npm test` — it is a separate runner, and
`--live-readonly` is the only argument it accepts. Without the flag it boots the real server in
a child process and talks JSON-RPC to it over a real pipe, while the *data* comes from a
synthetic fixture served from `127.0.0.1`; with the flag the data comes from the real store. It
reports `fixture: true/false` on every line so the two cannot be confused.
[the acceptance record](consumer-acceptance.md) shows both columns side by side.

**Guest live 2026-11-01: 9/9 PASS** (`MM_STORE_CODE=b2c_70010_vi npm run live`, no credential,
no write): 24 rows on page 0 and 7 on page 1 (`total_count` 31), detail resolved from a
search-issued alias slug, unknown tool and unknown argument both failed closed, clean exit,
no stderr noise. All observed prices were whole VND; none were payable claims.

## Reading the results

Each suite prints its own summary line; there is no combined banner. The real ones:

| What you see | What it means | What to do |
| --- | --- | --- |
| `74/74 auth setup checks passed (fake-only)` | the operator CLI suite held (fake fetch only) | nothing |
| `37/37 checks passed` / `42/42 checks passed` | the MCP framing suite and the guest catalog suite held | nothing |
| `33/33 checks passed, 2 live-only skipped (no request made — npm run live:parse)` | the account suite held offline; the 2 live-parse checks did not run, because `npm test` forces `MM_LIVE_PARSE=` empty for that suite | run `npm run live:parse` if you want those proven |
| `9/9 gate harness tests passed` / `20/20 tests passed` | the live-runner harness suites held | nothing |
| `28/28 checks passed` from the cart suite | the three cart write tools behaved as specified **against fakes**, and the shipped GraphQL documents are brace-balanced | nothing — it is not evidence the store accepted a write; run the cart write gate for that |
| `20/20 checks passed` from the cart write gate suite | the gate's own logic held against FAKE children (approvals refuse with zero requests, the applied claim needs the observed increment, a refused pre-read spends no mutation) | nothing — the FAKE children are not the store |
| `3/3 checks passed` from `npm run proof:cart` | the two shipped cart READ documents parse on the live site (anonymous; one negative control proved the probe detects a broken doc) | nothing about contents, and nothing about the three MUTATION documents — those are never sent here |
| anything with `FAIL` | a real regression | read the failing check name and the payload printed with it |
| `EPERM: operation not permitted, mkdir '<path>'` | the sandbox refused a path a test tried to create — an environment problem, not a code failure | run with a writable `HOME` and an explicit `timeout`, as in the recipe above |
| `MISSING_STORE_ENV` in a live run | `MM_STORE_CODE` was not set | set it |
| `REQUIRES_LOGIN` in a live account run | the credential file is missing, malformed, or the token no longer answers | rerun `npm run auth:setup` |

`npm test` also appends npm's own `npm notice …` update banner to the output. That is npm
talk, not the suites. It is also why the server itself must be started with `node`, not
`npm start` — see [setup.md](setup.md).

## What is deliberately not tested

- Anything requiring a browser session, localStorage, or a real browser cookie jar.
- One server process serving several client connections at once (the guard's in-process
  concurrency is covered by the cart suite; more than one process is not).
- HTTP/SSE transport.
- Performance under load; the per-request deadline (25 s, ≈50 s for a search) and body cap
  (2 MiB) are stated in [tools-reference.md](tools-reference.md), not benchmarked here. There
  is no retry logic in either module.
- Interoperability with a specific MCP client: `_meta` is accepted and unit-tested locally, and
  the MCP Python SDK 2.0.0 in the Hermes venv completed initialize / tools/list / tools/call
  (PASS, `2024-11-05`, 7 tools, no upstream calls), but that ran without Hermes configuration,
  so no client connection — Hermes included — is certified here.
