# mm-mcp

Minimal Model Context Protocol (MCP) server for MM Mega Market Vietnam: ten tools over
newline-delimited JSON-RPC 2.0 on stdio — two guest catalog reads, five authenticated
account reads, three authenticated cart writes (confirm-gated, and **not live-verified**:
no cart write has ever been sent from this repository). Protocol version `2024-11-05`,
held as a constant in `src/server.mjs`. No MCP SDK in the project: nothing to install,
nothing to migrate.

Audit findings and prioritized follow-up: [MCP audit](docs/mcp-audit.md).

## Request metadata (`params._meta`) — fixed locally, client uncertified

The server used to check request `params` against strict key allowlists that omitted `_meta`,
the metadata key current MCP clients attach to request params. That is repaired in
`src/server.mjs` (this pass, runtime code changed):

| Method | Accepted `params` keys | `params._meta` |
| --- | --- | --- |
| `initialize` | `protocolVersion`, `clientInfo`, `capabilities` | accepted if an object (then ignored); anything else `-32602` |
| `ping` | none | accepted if an object (then ignored); anything else `-32602` |
| `tools/list` | `cursor` | accepted if an object (then ignored); anything else `-32602` |
| `tools/call` | `name`, `arguments` | accepted if an object (then ignored); anything else `-32602` |

`_meta` is validated apart from the method arguments and then ignored: it never reaches the
tool implementation, and the per-method allowlists stay strict, so an unknown argument is
still refused.

- **Covered by tests:** `scripts/stdio.test.mjs` (initialize / ping / list / call, valid and
  invalid metadata, strict arguments, fractional and `Infinity` ids, fatal UTF-8 with
  recovery). Verified 2026-11-01: `npm test` under synthetic `HOME`/`XDG` =
  **255 pass, 2 live-only SKIP**, exit 0 (74 auth + 37 stdio + 42 catalog +
  33 account + 9 harness + 20 catalog live-runner + 27 cart + 13 cart write gate vs fake
  children). Separately, `node scripts/consumer-acceptance.mjs` on a
  loopback fixture: 30 checks, `fixture: true`.
- **SDK handshake exercised (2026-11-01):** MCP Python SDK 2.0.0 in the Hermes venv ran
  `initialize` / `tools/list` / `tools/call` against this server — **PASS**, protocol
  `2024-11-05`, 7 tools, no upstream calls
  (`~/.hermes/hermes-agent/venv/bin/python -B ~/.hermes/workspace/mm-sdk-check.py`).
  That run listed 7 tools: the three cart write tools were added afterwards and the SDK run
  has **not** been repeated, so the cart tools have no SDK evidence.
  `python3 -m pip show mcp` printing `WARNING: Package(s) not found: mcp` describes the
  system interpreter only and says nothing about that venv. The SDK is client-side: this
  repository still ships zero npm dependencies.
- **Not certified:** the configured Hermes session was never opened, so Hermes end to end is
  unproven. The old "Hermes fails to connect" note predates this fix; the SDK PASS above is
  SDK evidence with no Hermes configuration loaded, not a Hermes run.
- **Changed this pass:** three cart write tools added (`src/cart.mjs`, wired in
  `src/server.mjs`), so the surface is now ten tools. They are confirm-gated and proven only
  by offline fakes; stdio only, still zero dependencies.

## Scope of "read only"

- Seven of the ten MCP tools are reads. The other three (`mm_add_to_cart`,
  `mm_update_cart_item`, `mm_remove_cart_item`) do write to the owner's cart, and only when
  called with `confirm: true`; no address, session or cache mutation is reachable from a
  tool call, and there is still no checkout or order tool.
- The three cart writes are **not live-verified**: they are implemented and covered by
  offline fakes (`scripts/cart.test.mjs`), and no add/update/remove has ever reached the
  real endpoint from this repository. `npm run live:cart` is the gated runner that would
  produce that evidence; it refuses to run without an explicit approval. It has been run
  **once**, with approval (2026-11-01): the tool's own pre-read failed with a GraphQL
  `Syntax Error` (one missing brace in `CART_SNAPSHOT_QUERY`), so **zero mutations were
  dispatched** and nothing was added. The query is fixed, and `npm run proof:cart` proves
  both cart read documents parse on the live site (anonymous, 3/3). A verified write still
  requires another gated run.
- The repository has one other path, and it does write: `scripts/auth-setup.mjs` is an
  operator CLI, run by a human in a terminal, that sends one `SignIn` mutation upstream and
  writes the credential file locally. It is not an MCP tool, so a client cannot invoke it;
  calling it "read-only" would be wrong — it issues a token.

## The ten tools

| Tool | Context | Arguments | What you get |
| --- | --- | --- | --- |
| `mm_search_products` | guest | `query`, `page_index?`, `page_size?` | catalog search page, with prices |
| `mm_get_product` | guest | `url_key`, `expected_sku?` | detail for one exact product |
| `mm_auth_status` | authenticated | none | live proof that the stored credential still works |
| `mm_get_delivery_context` | authenticated | none | which store your account is bound to |
| `mm_list_addresses` | authenticated | `page_index?`, `page_size?` | saved address-book rows |
| `mm_get_cart` | authenticated | none | your cart, line by line |
| `mm_cart_summary` | authenticated | none | counts and totals only |
| `mm_add_to_cart` | authenticated, **write** | `sku`, `quantity`, `confirm: true` | one add, then the observed cart |
| `mm_update_cart_item` | authenticated, **write** | `item_uid`, `quantity`, `confirm: true` | one line's quantity changed, then observed |
| `mm_remove_cart_item` | authenticated, **write** | `item_uid`, `confirm: true` | one line removed, then observed |

Guest tools need no credential. Authenticated tools read the credential from a file and
prove it live on every call — no cached success, no login tool. The three write tools take no
cart id either: the cart is the authenticated owner's, resolved on every call (see
[docs/tools-reference.md](docs/tools-reference.md) for their sequences and verdict meanings).

## Requirements

Node.js 22 or newer (`package.json` engines: `>=22`). CI runs the offline suite on Node 22
and 24 (`.github/workflows/test.yml`); that matrix is what CI exercises, not an exhaustive
list of supported versions. Native `fetch` and `AbortSignal.timeout` only — zero npm
dependencies, no install step, no build.

## Response times

Each upstream request has a 25 s deadline (`TIMEOUT_MS` in `src/catalog.mjs` and
`src/account.mjs`, `POST_TIMEOUT_MS` in `src/cart.mjs` — the cart adapter POSTs, it never
sends a mutation as GET). `mm_search_products` issues **two sequential** requests — `ProductSearch`
(CARD), then `ProductSearchEnrich` (ENRICH) — each with its own 25 s deadline, so one valid
search can take up to roughly 50 s wall clock. Each cart write tool issues **three**
sequential requests (pre-read, one mutation, post-read), so one valid write can take up to
roughly **75 s**. Every other tool issues one request, so 25 s is its ceiling.

Consequence for anything wrapping the server: a caller-side timeout of 30 s is shorter than
those ceilings and can time out a search or a write that is still legitimately in flight. The
bundled stdio harness (`spawnGate` in `scripts/account-live.mjs`, reused by
`scripts/catalog-live.mjs` and `scripts/cart-live.mjs`) waits 30 s per request by default and
takes an optional named per-call bound (validated to 1…90 s, falling back to 30 s — a bad
timeout is never "wait forever"); the cart write gate names 80 s for its one write call so it
can see a slow-but-valid write finish, and keeps 30 s everywhere else. A timed-out write is
reported `unknown` (`mutation_count: 1`), never a definite rejection, and is never re-issued.
Set wrapper/client timeouts above ~50 s for search and above ~75 s for a cart write, or accept
the truncation as a harness limit.

## Configure an MCP client (illustrative, not certified)

Start the server with `node` directly, not through `npm start`: npm prints its own banner
onto stdout, and stdout is the single stream carrying the JSON-RPC frames.

```json
{
  "mcpServers": {
    "mm-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mm-mcp/src/server.mjs"],
      "env": {
        "MM_STORE_CODE": "b2c_NNNNN_vi"
      }
    }
  }
}
```

Two placeholders, both must be replaced:

- `/absolute/path/to/mm-mcp` — where this repository lives on your machine.
- `b2c_NNNNN_vi` — a generic store-code placeholder, not a claim about any real store. The
  accepted format is `b2c_` + 1–8 digits + `_vi`; use the code of the store you actually
  use. There is no default: with `MM_STORE_CODE` unset, both guest tools fail
  `MISSING_STORE_ENV` rather than guessing a store.

This block is a shape, not a verified working configuration — no client connection, Hermes
included, is certified here (see the metadata section above).

The authenticated tools look for the credential at `$MM_AUTH_FILE`, else
`$XDG_DATA_HOME/mm-mcp/auth.json`, else `~/.local/share/mm-mcp/auth.json`. Set
`MM_AUTH_FILE` if you keep it elsewhere.

## Set up the credential

Run `npm run auth:setup` (or `node scripts/auth-setup.mjs`) — the operator CLI, run by a
human in a terminal. The server exposes no login tool.

It reads exactly one JSON object `{ "email", "password", "store" }` from **stdin** — the
bearer token is never an input, it is what the `SignIn` mutation returns — prints either
`AUTH_SAVED` or one fixed error code, and writes
`{ "authorization": "Bearer <token>", "store": "<store code>" }` to the auth file with mode
0600. Nothing is accepted as a command-line argument, so no password lands in argv or shell
history. [docs/setup.md](docs/setup.md) has the prompt example (it propagates the CLI's exit
code) and the exact request sequence.

## Test it offline

```sh
npm test
```

Eight suites. None reaches the real endpoint or any external network: the suites answer from
canned payloads and local child processes over real pipes. No credential needed. Verified
2026-11-01: 255 pass, plus 2 anonymous live-parse checks that report `SKIP` because they
only run under `MM_LIVE_PARSE=1` (`npm run live:parse`). Skipped checks are not passes.
The cart suite's 28 checks and the cart write gate suite's 20 checks are all against fakes:
`applied` there means "the fake answered consistently", not "the store accepted a write".
`scripts/` is the authoritative source for
current counts.

`node scripts/consumer-acceptance.mjs` (not part of `npm test`) is also network-free in the
"no real endpoint" sense, but it is not socket-free: it binds a real HTTP fixture on
`127.0.0.1` and drives the real server over real stdio pipes.

Opt-in live gates, all separate from `npm test`:

```sh
MM_STORE_CODE=b2c_NNNNN_vi npm run live              # guest catalog, real endpoint
npm run live:parse                                   # do the shipped queries still PARSE? (anonymous)
MM_STORE_CODE=b2c_NNNNN_vi npm run live:account    # real credential needed, operator-local
MM_MCP_LIVE=1 MM_CART_WRITE_APPROVED=i_understand_this_changes_the_cart \
  MM_LIVE_SKU=<exact sku> MM_LIVE_QTY=<n> npm run live:cart   # ONE real add, operator-approved
node scripts/consumer-acceptance.mjs               # synthetic fixture, loopback, MCP over stdio
node scripts/consumer-acceptance.mjs --live-readonly   # same walk, real store, real data
```

`npm run live:cart` changes a real cart: it puts stock on your account and does not take it
back out again (no automatic cleanup — a cleanup would be a second mutation you did not
approve). Without all four variables it prints `{"status":"blocked", …}` and makes no
request at all. It has been run once, on 2026-11-01: the pre-read failed with a GraphQL
`Syntax Error` caused by one missing brace in `CART_SNAPSHOT_QUERY`, so **zero mutations
were dispatched** and no cart changed. The query is fixed (brace balance is now a check in
`scripts/cart.test.mjs`, and `npm run proof:cart` confirms it parses live); the write
itself is still **not verified** — a clean gated run has to happen after the fix.

## Documentation

| File | Contents |
| --- | --- |
| [docs/setup.md](docs/setup.md) | run without an install, MCP client config (illustrative), credential setup and re-login |
| [docs/tools-reference.md](docs/tools-reference.md) | every tool: arguments, returned shape, error codes, framing gaps |
| [docs/architecture.md](docs/architecture.md) | how the pieces fit, request flows, trust boundaries |
| [docs/testing.md](docs/testing.md) | suites, live gates, what SKIP/PASS mean, troubleshooting |
| [docs/auth-lifecycle-contract.md](docs/auth-lifecycle-contract.md) | evidence record for login, tokens, expiry |
| [docs/cart-write-contract.md](docs/cart-write-contract.md) | cart-write wire evidence; implemented offline, one gated live run blocked before dispatch (2026-11-01), **not live-verified** |
| [docs/consumer-acceptance.md](docs/consumer-acceptance.md) | consumer-level acceptance run: fixture vs live |

## Limits, stated plainly

- Cart `add`/`update`/`remove` now exist as MCP tools, but none of them is live-verified:
  they are proven only against offline fakes, and no cart write has ever reached the store
  from this repository (the one gated run on 2026-11-01 was blocked by its own failing
  pre-read and dispatched nothing). No address-selection tool, no checkout, no order. The
  operator CLI (`npm run auth:setup`) still writes a local credential file and sends one
  `SignIn` mutation.
  mutation; `npm run live:cart` is the only runner that would send a real cart mutation, and
  it requires explicit approval to do so.
- The `_meta` params gap that used to block clients that send request metadata is closed in
  `src/server.mjs` and covered by `scripts/stdio.test.mjs`; no MCP client connection,
  Hermes included, is certified here.
- Prices are what the page shows: `catalog-observed-not-guaranteed-payable`. Nothing here
  is a payable-price guarantee, an inventory count, or a reservation.
- `stock_status` is a label (`IN_STOCK`/`OUT_OF_STOCK`), not stock depth.
- A saved `default_shipping` address is stored data. Whether it is the address currently
  selected at checkout is **not** verified, and says nothing about the browser UI.
- Cart totals are copied from upstream, never recomputed or reconciled against the lines.
- One store, one origin, one context at a time: guest and authenticated views never swap
  silently.
- stdio transport only. No HTTP/SSE transport, no multi-client session handling, no caching,
  no rate limiting, no metrics, no MCP resources or prompts.
- Tool results are single text blocks. There is no `structuredContent` and no `annotations`
  in this server.
- Request ids are echoed unchanged. Only a string or an integer is accepted: a fractional or
  infinite id is refused `-32600` with `id: null` (see
  [docs/tools-reference.md](docs/tools-reference.md)).
- No automatic token refresh. When a credential stops working you get `REQUIRES_LOGIN` and
  rerun the setup CLI; the server re-reads the file per call, so no restart is needed.

## License

`UNLICENSED` and `private: true`. Not licensed for redistribution; see `package.json`.
