# Grocery consumer acceptance

Run from the repo root, Node 22+, no dependencies or package changes:

```sh
node scripts/consumer-acceptance.mjs
npm test
```

Default mode is **offline fixture acceptance, not live shopping evidence**.
It spawns the shipped `src/server.mjs`, sends newline JSON-RPC `initialize`,
`notifications/initialized`, `tools/list`, and `tools/call` over real child stdio.
It never fabricates MCP responses or calls tool implementations directly.

The upstream origin is fixed in the shipped modules. Offline mode uses Node's
`--import` to load this same script in the child and redirect native `fetch`
from that exact GraphQL origin to an ephemeral loopback HTTP fixture. Other
origins, non-GET requests and non-query documents are rejected. The fixture
accepts only the five exact shipped GraphQL documents. This is a **test-only
transport substitution**, not proof of real upstream behavior. No server source
changes, remote requests, real account credentials or private configuration reads
are needed. The runner writes a temporary owner-private synthetic credential;
only the child reads it. Offline child environment is constructed from scratch,
so inherited auth paths, proxy settings and `NODE_OPTIONS` cannot activate live IO.

## Assertions

- Exactly the seven shipped read tools exist. No cart write, checkout, address
  selection, recipe or nutrition tool is available. Unknown write calls fail
  locally with JSON-RPC `-32602`, without upstream traffic.
- Synthetic profile requires six eggs and has two eggs in inventory. Generic
  product selection is ambiguous; exact SKU still cannot establish eggs per box.
  Unknown or mismatched conversions remain blocked. Only an explicit **synthetic**
  same-store SKU/unit conversion permits a non-executable proposal of one box.
  No package size is parsed from a name; no medical data or nutrition is invented.
- Existing cart quantity `0.5` and total quantity `1.5` survive projection unchanged.
  Fractional existing quantities do not imply fractional write support: a synthetic
  0.5 kg deficit rounds to one catalog quantity step, not a proposed 0.5 cart write.
- Stock label and observed catalog price retain guest/store context and
  `observed_at`. Consumer freshness ceiling is 60 seconds (test policy, not an
  upstream SLA). Old observations and unavailable stock block proposals.
  `observed_at` is response observation time, **not** stock-change time or a
  reservation. Prices are not guaranteed payable; promotions are not applied.
- Saved `default_shipping: true` does not bind delivery. Store proof and
  `address_selection: NOT verified` remain separate; cart shipping is count/labels.
- Both protected pre-existing cart lines, including an unrelated SKU, remain
  unchanged after proposals, failures and rejected writes. Fixture upstream rows
  also remain unchanged. This proves non-mutation in the fixture only.
- Multiple exact-detail products, SKU mismatch, empty search, store mismatch,
  missing cart, GraphQL errors and invalid arguments fail closed. Actual server
  tool errors are `isError` plus text codes, **not** structured MCP error objects.
  The consumer normalizes their code into `{ blocked: true, code }`; ambiguity
  and conversion blocks are local consumer decisions, not invented server tools.
- Every successful read has a parseable timestamp within the child lifetime.
  Bounded stdio harness is reused from `account-live.mjs` (30-second calls,
  2 MiB stdout cap, stderr discarded, duplicate-frame counting, five-second
  graceful close then kill, exit-hook cleanup). A `finally` closes the child and
  fixture and removes temporary state on normal or failed assertions.

## Optional operator-only live read

```sh
node scripts/consumer-acceptance.mjs --live-readonly
```

This mode spawns the actual server without preload, inherits its environment
unchanged, and uses its actual upstream and auth lifecycle. The runner never
opens auth files. It reads catalog, optional exact product detail, auth proof,
delivery context, one saved-address page, cart and cart summary. These read
replies may contain private rows **in memory**; stdout contains only fixed-key
counts and booleans. Raw replies, items, addresses, store labels, tokens, stderr
and assertion messages are never printed, including on failure. Failure exits 1.
No write tool is called in live mode. Missing/expired auth fails, not a skip or
fabricated success. No live run is part of offline acceptance.

Live counts are mutable. Cart and summary are validated independently; concurrent
edits can differ. There is no before/after equality claim for live protected lines.
Guest catalog and authenticated account stores need not match; no live plan or
cross-context price claim is made. No fixture conversion is used in live mode.
`shopping_certified` is always false: neither mode certifies a full grocery planner,
recipe/nutrition correctness, package conversion, payable total, delivery-address
binding, stock reservation, approved cart edits, checkout or order placement.
