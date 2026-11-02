# MM MCP task ledger

Owner: April (intent, contracts, architecture, acceptance). Executor: separate Pi/code-local tasks. Reviewer: separate Pi/code-review session. Target: ledthang/mm-mcp. User authorized autonomous submission (commit/push/PR) and GitHub issue management for this repo on 2026-10-31. Tests and independent review remain required. No checkout/payment or unrelated repository authority. Do not modify BHX repo.

## Current evidence

- Homepage and live browser work; GraphQL GET/POST observed.
- Fresh browser default store header b2c_10010_vi (An Phu), not user's delivery choice.
- UI search for trứng reports 32 products. Actual search products operation still needs capture; description/sort operations are not search results.
- Product-by-url-key operation observed with SKU, unit_ecom, price_range.maximum_price.final_price/regular_price and dnr_mcard. Promotions and member prices must remain distinct.
- Vaultwarden synced, expected account/server/collection checked. Exactly one matching item Mega Market has a password. No secrets printed/stored here. Actual MM login not attempted yet.
- Prior Pi runs produced no files; task-marker failure and task timeout, not proof of model death.

## T0 — April: login and contract proof (in progress)
Input: live MM site, exact Mega Market vault item, existing BHX protocol conventions.
Actions: inspect real login DOM; inject credential internally using private process memory, never task prompts or CLI args. Stop for OTP/CAPTCHA if necessary. Capture actual catalog search, detail and store context requests. Prove native fetch replay; use browser-backed session only if native replay insufficient.
Artifacts: docs/contracts.md with sanitized operation/variables/headers/fields, docs/acceptance.md with evidence and unresolved gates. Runtime profile outside repo mode 700.
Gate: real search and exact SKU detail agree with rendered name/unit/price in same store/session; authenticated status based on explicit account response, not cart readability. No cart changes.
Dependencies: none. Do not delegate product transport until completed.

## T1 — Pi: stdio MCP core (ready, independent of T0)
Files: package.json, src/server.mjs, scripts/stdio.test.mjs, .gitignore only.
Scope: Node ESM >=22, stdlib only; initialize, ping, tools/list (empty until verified tools exist), JSON-RPC errors, notifications no response/no side effects, serial bounded newline input, stdout protocol only. Export handler for focused tests. No network, browser, credential, auth/cart stubs. Runtime/secrets ignored.
Gate: node scripts/stdio.test.mjs exercises spawned server, initialize/ping/list, malformed JSON/method/arguments and notifications. npm test succeeds. No commit/push.
Stop after these files and summarize actual test output. Deadline 4 minutes; primary inspects files after 90 seconds. Failure gets narrow correction on same route, no blind broad rerun.

## T2 — Pi: catalog (blocked on T0 + T1)
Files: src/catalog.mjs, minimal server changes, one compact captured-fixture test; package changes only if T0 proves browser dependency necessary.
Tools: mm_search_products(query,page_index,page_size), mm_get_product(sku). Strict unknown-argument/type/range validation; search 0-based externally translated to observed upstream paging. SKU treated as opaque validated string. Explicit store context required, no guessed user address. Bound timeout/response size. GraphQL errors fail closed; missing price not zero; no fabricated stock count. Preserve unit/quantity step, ordinary/member/promotion distinction, timestamp and context.
Gate: fixtures prove mappings and errors; real stdio initialize/list/search/detail agrees with T0 evidence. Catalog price not guaranteed payable.

## T3 — Pi: persistent auth + delivery reads (blocked on T0)
Tools only where verified: mm_auth_status, mm_get_delivery_context, mm_list_addresses, mm_get_cart, mm_cart_summary. Existing authenticated runtime profile shared by login and server. No password tool arguments; credential retrieval remains outside model prompts. Explicit guest/requires-login vs transport failure. Redact logs; no raw account/address data in public fixtures.
Gate: active authenticated read, process restart persistence, fresh-profile guest negative case, context after restart. Address selection only after user identifies target.

## T4 — Pi: guarded cart writes (blocked on verified T3 and explicit trial approval)
Tools: add/update/remove with user_authorized true, quantity and maximum-price limits, foreign-line protection. Actual UI request contract only. Reload owner's visible cart to verify, not add echo or arbitrary cart ID. Trial approval must specify SKU, quantity, max price, cleanup scope. No checkout/order/payment tools.
Gate: authorized add/read/update/remove cycle, original cart restored and foreign lines unchanged; ambiguous mutation outcome stops further writes. No live trial currently authorized.

## T5 — independent review + delivery
Pi/code-review receives exact snapshot and scope, read-only; findings return to executor for narrow fix. April independently reruns full tests and real stdio acceptance. README names verified and blocked capabilities, setup and secret handling. Scan tracked/untracked files for credentials and generated artifacts. Config registration/publish require authority; no gateway restart autonomously. Repo URL alone not push approval.

## Progress rules

Each task has one writer. Do not launch next dependent task on prose claims. Verify artifact and gate output first. No progress-only status loops; intervene if no artifacts by bounded checkpoint. Report tests, live evidence, review and publish state separately. Catalog slice is not full BHX parity.
