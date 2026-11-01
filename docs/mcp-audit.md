# MCP audit — 2026-11-01

## Scope and verdict

Audit of the shipped Node.js stdio server against its declared MCP `2024-11-05` baseline, using the `mcp-builder` review criteria. This is an audit, not a runtime repair or certification of every MCP client.

**Hermes interoperability was blocked by `_meta` — repaired locally 2026-11-01, Hermes session still uncertified.** Valid request metadata (`params._meta`) used to be rejected; an object `_meta` is now accepted on `initialize`, `ping`, `tools/list` and `tools/call` and then ignored. The MCP Python SDK used by Hermes reproduced the initialization failure before this fix (earlier audit run, an SDK build emitting `_meta: {}` on every method). After the fix, MCP Python SDK 2.0.0 installed in the Hermes venv was run against the shipped server: `~/.hermes/hermes-agent/venv/bin/python -B ~/.hermes/workspace/mm-sdk-check.py` → PASS, initialize / tools/list / tools/call all succeeded, negotiated `protocolVersion` `2024-11-05`, 7 tools discovered, no upstream calls made. `python3 -m pip show mcp` → `Package(s) not found: mcp` describes the system interpreter only and is irrelevant here — the SDK lives in the venv. The configured Hermes session was still not opened, so Hermes end to end remains uncertified; earlier public/account live gates exercised a hand-built client without this metadata, and their successful results did not establish Hermes compatibility.

The published surface contains seven read tools. No add, update or remove-cart tool exists. Fixing metadata alone will not enable cart writes. This audit performed no real account/cart reads or writes, login, or credential inspection.

## Checks and evidence boundaries

- Re-ran `npm test` under synthetic HOME/XDG after the repairs, 2026-11-01: exit 0, 212 offline checks passed (74 auth + 37 stdio + 42 catalog + 33 account + 6 harness + 20 catalog live runner), two live-only checks skipped. Before the added stdio regressions, the total was 199.
- Exercised actual `node src/server.mjs` over stdio with synthetic environment: pre-fix, metadata requests failed and baseline initialize/list succeeded; post-fix (this pass, 2026-11-01) a raw probe with `_meta` on `initialize` and on `tools/list` returns the normal initialize result and the seven-tool page, and `id: 2.5` / `id: 1e999` return `-32600` with `id: null`.
- Ran the MCP Python SDK's `ClientSession` (2.0.0, in the Hermes venv, Hermes configuration not loaded) against the shipped server twice: pre-fix it emitted `_meta: {}` and initialization failed; post-fix it completed initialize, listed the seven tools and made a successful tool call over `protocolVersion` `2024-11-05` with no upstream calls. This is SDK interoperability evidence, not a full configured Hermes session capture.
- Source inspection and synthetic probes do not establish current upstream account state, stock, prices, selected delivery address or write semantics.
- The earlier documentation/audit pass changed no runtime files. This pass (2026-11-01) did: `src/server.mjs` (metadata, ids, fatal decoding) and `scripts/stdio.test.mjs` (covering checks). Nothing else in `src/` or `scripts/` was touched; no new dependency, no transport change, no cart-write tool added.

## Confirmed findings

### A1 — Medium: standard request metadata blocks clients — **repaired locally 2026-11-01, client uncertified**

`src/server.mjs`, `INIT_KEYS`, `LIST_KEYS`, `CALL_KEYS`, `extraKeys`, and the `ping` case reject `_meta`.

The installed SDK emitted this initialize shape (client identity is SDK default):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp","version":"0.1.0"},"_meta":{}}}
```

Actual response: JSON-RPC `-32602`, `unknown params: _meta`. Metadata also fails with the server's own requested version `2024-11-05`, so this is not explained by version downgrade. Independently initialized raw sessions reject metadata on `tools/list` and `tools/call`; `ping` returns `ping takes no params`.

Minimal repair: validate request-level `_meta` independently of method arguments, ignore unused valid metadata, and preserve strict tool argument validation. Cover initialize, list, call and ping—not initialize alone. Add an installed-SDK handshake/discovery regression and verify protocol downgrade. No SDK dependency or progress implementation is necessary for this repair.

**Repair record (2026-11-01, this pass).** `src/server.mjs` now validates request-level
`_meta` apart from the method arguments on all four handled methods: an object (including the
`{}` the SDK sends) is accepted and ignored, any other type is `-32602` naming `_meta`, and
an unknown argument next to valid metadata still reports that argument, so tool-argument
strictness is unchanged. `scripts/stdio.test.mjs` grew the covering checks (now 37, all
passing, offline). **Installed-SDK regression taken after the repair:** MCP Python SDK 2.0.0
in the Hermes venv (`~/.hermes/hermes-agent/venv`) ran initialize / tools/list / tools/call
against the server and passed, negotiating `2024-11-05` with 7 tools and no upstream calls
(`~/.hermes/workspace/mm-sdk-check.py`). `python3 -m pip show mcp` →
`WARNING: Package(s) not found: mcp` covers the system interpreter only, not that venv. The
configured Hermes session is still **not** certified. Protocol-version handling is
unchanged (`2024-11-05` echoed as a constant).

### A2 — Low: invalid UTF-8 is replaced rather than rejected — **repaired locally 2026-11-01**

`src/server.mjs`, `runStdio`/`answer`, decodes complete input with `Buffer.toString("utf8")`. A synthetic request with byte `0xff` inside a string ID is accepted after replacement with `U+FFFD` and receives a successful ping response under the altered ID. Valid multibyte chunk splitting is already handled correctly; invalid encoding is a separate gap.

Recommendation: use fatal UTF-8 decoding for complete lines, return a parse error on invalid bytes, and test recovery on the following valid line. No remote exploit demonstrated.

**Repair record (2026-11-01).** `runStdio` decodes each complete, in-cap line through one
`TextDecoder("utf-8", { fatal: true })`; a decode failure writes exactly one
`-32700 Parse error: invalid UTF-8` with `id: null` and the loop continues with the next
line. Frame bounds are unchanged (byte 10 split, 64 KiB cap, head of an oversized line is
still dropped rather than kept), valid multibyte characters split across chunk boundaries
still decode, and byte-level blank/CRLF lines stay silent. `scripts/stdio.test.mjs` covers
invalid bytes in one write, invalid bytes across two chunks, and a valid `é` pair split
across two chunks (37 checks, all passing, local pipes only).

### A3 — Low: fractional numeric request IDs accepted — **repaired locally 2026-11-01**

`src/server.mjs`, `isId`, accepts any finite number. Direct probe `id: 2.5` receives a successful ping result. The pinned MCP messages specification requires string or integer request IDs.

Recommendation: require integer numeric IDs and retain string IDs; add a local protocol regression. This is malformed-input conformance, not an authentication bypass.

**Repair record (2026-11-01).** `isId` is now `typeof v === "string" || Number.isInteger(v)`,
so `2.5` and `1e999` (parsed as `Infinity`) answer `-32600` with `id: null`, while integers,
`"0"` and `"abc-9"` are still accepted and echoed unchanged. Covered by
`scripts/stdio.test.mjs`.

### A4 — Medium, defense in depth: address privacy wording exceeds projection

`src/account.mjs`, `pageProof`, validates the presence of custom attribute keys and returns `custom_attributes` objects wholesale. The tool description says no email/name/phone fields, but arbitrary custom attributes can themselves carry private data or extra keys.

This is a source-confirmed projection risk, not observed real identity leakage. The address tool intentionally returns private address data.

Recommendation: narrow the guarantee to explicit top-level identity fields not queried; treat all returned address attributes as private. A stronger attribute allowlist needs verified business requirements and synthetic privacy tests, not guessed field removal.

### A5 — Low: requested page size is not a response-count bound

`src/catalog.mjs`, `search`, and `src/account.mjs`, `pageProof`, do not reject accepted upstream rows merely because their count exceeds requested `page_size`. Output metadata can therefore describe a smaller page than the projected rows. Existing 2 MiB body limits still bound upstream data; this is not an unbounded-memory finding.

Recommendation: synthetic overfull-page tests and fail-closed row-count validation before enrichment/projection. This finding follows source inspection; no additional upstream probe performed.

## Qualified design observations

- Argument-content validation currently returns tool-result `isError: true`; dispatch-level malformed arguments use JSON-RPC `-32602`. Aligning these categories is a low-priority interoperability recommendation, not a demonstrated authentication or MUST-level failure.
- Auth status/delivery proof queries fetch address data that their final projections omit. Query minimization is a privacy improvement only after verifying the narrower query contract.
- Dispatch is serial. Cancellation cannot interrupt an in-flight request; ping waits behind it. Each upstream request has a 25-second deadline, but search performs two sequential requests and can approach 50 seconds. Bundled harness waits 30 seconds per call, so a valid slow search may time out at the client first.
- Initialization marks the session ready before `notifications/initialized`; notifications do not change state. Missing-client-notification rejection is not asserted as a server MUST. Pre-initialize ping is rejected; initialization-time ping support is an interoperability improvement.
- The auth-status recovery description still mentions browser-session export although the operator setup CLI exists. Docs now describe the actual manual re-login path; runtime description is unchanged.

## Modern enhancements are not baseline defects

`structuredContent`, `outputSchema`, tool annotations, Streamable HTTP and OAuth are not required additions to this local stdio server merely because current guidance discusses them. JSON text tool results, seven static tools on one discovery page and no resources/prompts are consistent with the advertised small surface. Do not force a framework migration or add dependencies solely to satisfy a checklist.

## Prioritized follow-up

1. Repair `_meta` compatibility and prove initialization/discovery with the installed SDK and actual Hermes path before claiming Hermes usability. **Partly done 2026-11-01:** `_meta` is accepted and tested locally (37 stdio checks, exit 0), and the installed MCP Python SDK 2.0.0 in the Hermes venv completed initialize / tools/list / tools/call (PASS, `2024-11-05`, 7 tools, no upstream calls). The configured-Hermes half is still open — no Hermes session was opened.
2. Address malformed encoding/ID validation with compact protocol regressions. **Done 2026-11-01:** fatal UTF-8 decoding plus string-or-integer ids, both covered in `scripts/stdio.test.mjs`.
3. Resolve privacy claims and page-count validation with synthetic fixtures.
4. Consider cancellation, deadline alignment and newer protocol features only with explicit scope.
5. Treat cart writes as a separate feature with owner binding, quantity semantics, unknown-outcome reconciliation and explicit mutation approval. No permission follows from this audit.

## References

- [Pinned request/response rules](https://modelcontextprotocol.io/specification/2024-11-05/basic/messages)
- [Pinned lifecycle](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle)
- [Pinned tools](https://modelcontextprotocol.io/specification/2024-11-05/server/tools)
- [Pinned request metadata schema](https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/2024-11-05/schema.ts)
- [Hermes MCP integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)

See [testing](testing.md) for the current offline/live distinction and [tool reference](tools-reference.md) for shipped behavior. Review findings are not a claim that fixes have been applied.
