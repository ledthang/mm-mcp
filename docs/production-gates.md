# Production gates

Scope: MM shopping MCP, no checkout/payment/order submission. Owner retains contract/acceptance; OpenCode code-local implements bounded tasks; independent Pi code-review. Each feature needs tests + live stdio + reviewed source hashes before submission. Broad continuation does not authorize live cart changes.

## Verified shipped
- Core stdio + guest catalog: 46 checks, live search, independent review; 06b8888.
- Auth status, store context, saved addresses: 71 checks, persistent browser session, native and stdio authenticated reads, independent review; f91db94.
- Credentials outside repo. Guest catalog store remains explicitly separate from authenticated context.

## Remaining dependency order
1. Cart reads: owner-only customerCart, no supplied ID, bounded/redacted transport, VND totals and decimal quantity. Native proof HTTP200 exists. Browser cart route currently fallback despite native cart; investigate, do not claim UI parity.
2. Delivery context: explain browser/store/cart mismatch; verify selected-address identity before writes, never infer from saved default_shipping. No address mutation without user selection.
3. Product detail and authenticated pricing: capture actual URL-key contract, exact product identity, store-bound live proof; distinguish guest/member/cart totals.
4. Auth lifecycle: operator setup/renewal, expiry fail-closed, restart behavior, safe recovery. Current secret-file export is manual; no automatic login shipped.
5. Guarded cart writes: request contracts and preflight first. Live trial requires explicit SKU, quantity, price ceiling, foreign-line snapshot and restoration permission. No blind retries after ambiguous write.
6. Operational hardening: deterministic offline test command separate from explicit live gates, CI Node supported versions, protocol errors/output bounds, security review, setup/runbook and readiness checklist.
7. Final acceptance: cold start, missing/expired auth, context mismatch, network failure and complete authorized cart cycle. No production-ready claim while required gates unresolved.

## Current task
T4a: src/account.mjs + focused tests + README only. mm_get_cart and mm_cart_summary, no mutations. Executor launched 2026-10-31; primary independently exercises actual stdio and sends exact snapshot to reviewer. Next task begins after accepted submission, not another user prompt.
