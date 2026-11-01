# mm-mcp

Minimal Model Context Protocol (MCP) server for MM Mega Market Vietnam: seven tools over
newline-delimited JSON-RPC 2.0 on stdio — two guest catalog reads, five authenticated
account reads. Protocol version `2024-11-05`, held as a constant in `src/server.mjs`. No
MCP SDK in the project: nothing to install, nothing to migrate.

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
  **212 pass, 2 live-only SKIP**, exit 0 (74 auth + 37 stdio + 42 catalog +
  33 account + 6 harness + 20 catalog live-runner). Separately, `node scripts/consumer-acceptance.mjs` on a
  loopback fixture: 30 checks, `fixture: true`.
- **SDK handshake exercised (2026-11-01):** MCP Python SDK 2.0.0 in the Hermes venv ran
  `initialize` / `tools/list` / `tools/call` against this server — **PASS**, protocol
  `2024-11-05`, 7 tools, no upstream calls
  (`~/.hermes/hermes-agent/venv/bin/python -B ~/.hermes/workspace/mm-sdk-check.py`).
  `python3 -m pip show mcp` printing `WARNING: Package(s) not found: mcp` describes the
  system interpreter only and says nothing about that venv. The SDK is client-side: this
  repository still ships zero npm dependencies.
- **Not certified:** the configured Hermes session was never opened, so Hermes end to end is
  unproven. The old "Hermes fails to connect" note predates this fix; the SDK PASS above is
  SDK evidence with no Hermes configuration loaded, not a Hermes run.
- **Unchanged:** seven read tools, no cart writes, stdio only.

## Scope of "read only"

- The seven MCP tools are reads: no cart, address, session or cache mutation is reachable
  from a tool call.
- The repository has one other path, and it does write: `scripts/auth-setup.mjs` is an
  operator CLI, run by a human in a terminal, that sends one `SignIn` mutation upstream and
  writes the credential file locally. It is not an MCP tool, so a client cannot invoke it;
  calling it "read-only" would be wrong — it issues a token.

## The seven tools

| Tool | Context | Arguments | What you get |
| --- | --- | --- | --- |
| `mm_search_products` | guest | `query`, `page_index?`, `page_size?` | catalog search page, with prices |
| `mm_get_product` | guest | `url_key`, `expected_sku?` | detail for one exact product |
| `mm_auth_status` | authenticated | none | live proof that the stored credential still works |
| `mm_get_delivery_context` | authenticated | none | which store your account is bound to |
| `mm_list_addresses` | authenticated | `page_index?`, `page_size?` | saved address-book rows |
| `mm_get_cart` | authenticated | none | your cart, line by line |
| `mm_cart_summary` | authenticated | none | counts and totals only |

Guest tools need no credential. Authenticated tools read the credential from a file and
prove it live on every call — no cached success, no login tool.

## Requirements

Node.js 22 or newer (`package.json` engines: `>=22`). CI runs the offline suite on Node 22
and 24 (`.github/workflows/test.yml`); that matrix is what CI exercises, not an exhaustive
list of supported versions. Native `fetch` and `AbortSignal.timeout` only — zero npm
dependencies, no install step, no build.

## Response times

Each upstream request has a 25 s deadline (`TIMEOUT_MS` in `src/catalog.mjs` and
`src/account.mjs`). `mm_search_products` issues **two sequential** requests — `ProductSearch`
(CARD), then `ProductSearchEnrich` (ENRICH) — each with its own 25 s deadline, so one valid
search can take up to roughly 50 s wall clock. Every other tool issues one request, so
25 s is its ceiling.

Consequence for anything wrapping the server: a caller-side timeout of 30 s is shorter than
that ceiling and can time out a search that is still legitimately in flight. The bundled
stdio harness uses exactly that 30 s (`CALL_TIMEOUT` in `scripts/account-live.mjs`, reused by
`scripts/catalog-live.mjs`), so a slow-but-valid search can show up as a harness timeout
rather than a server failure. Set wrapper/client timeouts above ~50 s for search, or accept
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

Six suites. None reaches the real endpoint or any external network: the suites answer from
canned payloads and local child processes over real pipes. No credential needed. Verified
2026-11-01: 212 pass, plus 2 anonymous live-parse checks that report `SKIP` because they
only run under `MM_LIVE_PARSE=1` (`npm run live:parse`). Skipped checks are not passes.
`scripts/` is the authoritative source for current counts.

`node scripts/consumer-acceptance.mjs` (not part of `npm test`) is also network-free in the
"no real endpoint" sense, but it is not socket-free: it binds a real HTTP fixture on
`127.0.0.1` and drives the real server over real stdio pipes.

Opt-in live gates, all separate from `npm test`:

```sh
MM_STORE_CODE=b2c_NNNNN_vi npm run live              # guest catalog, real endpoint
npm run live:parse                                   # do the shipped queries still PARSE? (anonymous)
MM_STORE_CODE=b2c_NNNNN_vi npm run live:account    # real credential needed, operator-local
node scripts/consumer-acceptance.mjs               # synthetic fixture, loopback, MCP over stdio
node scripts/consumer-acceptance.mjs --live-readonly   # same walk, real store, real data
```

## Documentation

| File | Contents |
| --- | --- |
| [docs/setup.md](docs/setup.md) | run without an install, MCP client config (illustrative), credential setup and re-login |
| [docs/tools-reference.md](docs/tools-reference.md) | every tool: arguments, returned shape, error codes, framing gaps |
| [docs/architecture.md](docs/architecture.md) | how the pieces fit, request flows, trust boundaries |
| [docs/testing.md](docs/testing.md) | suites, live gates, what SKIP/PASS mean, troubleshooting |
| [docs/auth-lifecycle-contract.md](docs/auth-lifecycle-contract.md) | evidence record for login, tokens, expiry |
| [docs/cart-write-contract.md](docs/cart-write-contract.md) | cart-write research (not implemented) |
| [docs/consumer-acceptance.md](docs/consumer-acceptance.md) | consumer-level acceptance run: fixture vs live |

## Limits, stated plainly

- No cart, address, session or cache mutation is reachable from MCP: no `add`/`update`/
  `remove` tool, no address-selection tool, no checkout, no order. The operator CLI writes
  a local credential file and sends one `SignIn` mutation; that is the only write path.
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
