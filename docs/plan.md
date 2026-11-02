# MM MCP — scope and acceptance

Target: https://github.com/ledthang/mm-mcp
Reference only: ../bachhoaxanh-mcp. Do not clone BHX-specific endpoints or auth assumptions.

## Verified discovery (2026-10-31)

Primary assistant ran curl and headless Playwright directly using installed BHX Playwright dependency. Homepage HTTP 200, 69699 bytes; title Trung Tâm MM Mega Market Vietnam. Browser rendered catalog. Actual fetch/XHR traffic uses GET and POST https://online.mmvietnam.com/graphql (HTTP 200); individual operations and schemas NOT captured yet. No account login performed. Fresh browser displays default MM Mega Market An Phú; this is NOT user's selected delivery address. Product cards distinguish normal price, promotion, MCard price, unit (Ký/Gói/Lốc etc.). Member price display does not prove membership or payable price. Search input observed: input[name="search_query"], placeholder Bạn cần tìm sản phẩm gì?. No cart mutations or order/payment actions performed.

Two executor discovery attempts produced no files: first pi_task_marker_missing, second pi_task_timeout. These are task failures, not verified code-local unavailability. No executor switch authorized.

## Architecture

Node ESM stdio MCP, matching BHX transport convention. Choose native fetch only if captured operation works outside browser with explicit store context; otherwise use one lazy persistent Playwright session. Do not introduce both paths speculatively. Runtime state outside repo, no cookies/tokens/account/address data in evidence or logs. Server stdout JSON-RPC only; diagnostics stderr. No checkout/payment tool.

## Ordered tasks (one executor assignment per gate)

1. Primary assistant captures actual search request, response, store headers and one detail operation. Replay with explicit context, compare SKU/price/unit to DOM. Decide transport from results. This is prerequisite to implementation.
2. Pi: MCP initialize/tools/list/notifications and strict input validation only. One node:assert test over stdio, unknown args rejected, notifications never cause side effects. No live business tools until contracts known.
3. Pi: mm_search_products and mm_get_product using captured contracts. Bound query/pagination/timeouts; preserve SKU/unit, separate displayed normal/promo/member prices, timestamp and store. Test captured sanitized fixtures plus real stdio search/detail readback.
4. Pi: auth status and delivery context, only after primary assistant proves actual source. Guest must be explicit. Never infer authenticated from cart readability. Persistent profile path shared across login and server. Login handoff only after actual flow observed; never guess OTP endpoints.
5. Saved-address/cart reads require real account workflow. If login needed, ask user for MM login choice rather than reuse BHX identifier. Expose only verified capabilities; do not return fake empty cart/address arrays on failures.
6. Cart mutations separate gated task: explicit user authority, quantity/max-price validation, preserve foreign lines, verify reload of owner's visible cart, restore bounded trial. No live mutation authorized by current request. Do not expose unimplemented mutation tools.
7. Independent Pi code-review of exact snapshot. Primary assistant runs tests and real stdio gates. Document verified vs blocked features. Commit/push/config registration only after relevant authority; repo URL alone is not publish permission.

## Delivery rule

First working catalog slice is bounded progress, not full BHX parity. No PASS from mocks alone. Report each live gate separately and keep remaining auth/cart scope explicit.
