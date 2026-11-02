# MM operator auth lifecycle: evidence and bounded setup

Reviewed 2026-10-31 against repository base `45f86fe`. Public-source discovery below
is retained as historical static evidence. A separately **supplied primary live
observation** now supports bounded operator setup/manual re-login. This work adds
the stdlib-only setup CLI and fake tests, not automatic refresh or an MCP login tool.
No live requests or private probe/vault/auth reads are performed by this work.

## Supplied primary observation and current limits

The operator explicitly supplied the following completed, authorized observation;
it was not rerun or independently verified in this work:

- `recaptchaV3Config` had `CUSTOMER_LOGIN` disabled at observation time.
- POST to fixed `https://online.mmvietnam.com/graphql`, Store `b2c_70010_vi`, using
  `mutation SignIn($email:String!,$password:String!){generateCustomerTokenV2(email:$email,password:$password){token}}`
  succeeded. A cookie-free read of `customer{__typename}` and
  `storeConfig{store_code}` with its returned Bearer proved `Customer` and the same store.
- Separate `GenerateAuthSession` succeeded and set a Secure `mmpro_rt` cookie.
  Cookie-based refresh succeeded; the refreshed bearer also worked cookie-free.
  No cookie values, tokens, passwords, or primary probe contents are included here.
- No cart mutations were performed. This is **one observation**, not a guarantee
  that CAPTCHA remains disabled, that every account avoids challenges/MFA, or that
  token lifetime/`expires_in` units or rotation semantics are known.

The CLI rechecks configuration before every login, fails closed on unknown config
or enabled `CUSTOMER_LOGIN`, makes one login attempt, and proves bearer/store before
writing. It does not issue auth sessions or capture/persist cookies. Automatic
refresh remains outside scope because cookie persistence adds a separate lifecycle
and security contract; the observed refresh success does not implement that contract.

## Historical static evidence and confidence

Public source: `<capture>/mm-asset-client.621acc48af8c317cdd54.js`
(`<capture>` is this evidence's local capture directory, kept outside the plugin
repo and not committed; set it wherever you re-fetch the public chunk.)

- File size: 1,529,158 bytes; decoded JavaScript length: 1,519,515 UTF-16 code units.
- SHA-256: `9a5bceab01afed2fefcd3ba5a6986cad1b3bbdd34907e73b79ed1401c388f615`.
- All ranges below are zero-based, end-exclusive. Byte ranges refer to original
  UTF-8 bytes; UTF-16 ranges refer to JavaScript `String.slice(start, end)`.
- **Verified/local:** source identity, literal operation shapes, and call sites
  inspected statically; existing account reader's schema and fail-closed behavior
  inspected in `src/account.mjs`. This does not verify server acceptance.
- **Static only:** browser request construction, token storage, and expiry logic.
- **Unknown/live in the earlier discovery pass:** server-accepted login inputs, token/cookie behavior, MFA/challenge
  requirements, actual expiry, rotation, and compatibility of refreshed tokens with
  the account module's cookie-free requests. This continuation used already-fetched
  public assets offline; no network request or blocked-network retry was attempted.
- No private auth file, vault, browser profile, environment credentials,
  login-proof script, or provider configuration was read. No login, refresh,
  logout, cart, or address mutation was performed.

### Source index

Minified identifiers in the Evidence column (`LFJS`, `YRuz`, `setToken`, `yu8+`, `6i0m`,
`kSvd.b`, `dhg2`) are labels carried over from the earlier discovery notes. They are **unverified
names** — ranges are the evidence, not the labels; a mislabeled span shows up as text that does
not match its description. Do not quote an identifier as fact without re-checking its range.

| ID | UTF-8 bytes | UTF-16 code units | Evidence |
| --- | --- | --- | --- |
| S1 | [337364, 340117) | [337363, 340116) | `LFJS`: MCard operations, lifetime query, cart operations |
| S2 | [595139, 597058) | [593730, 595649) | `YRuz`: auth-session generation, refresh, logout, storage |
| S3 | [260571, 260728) | [260570, 260727) | Stored customer-token TTL expiry check |
| S4 | [741932, 742427) | [735530, 736025) | `setToken`: default lifetime and hours-to-seconds conversion |
| S5 | [1137959, 1138529) | [1131480, 1132050) | Remaining TTL and scheduled sign-out |
| S6 | [1219746, 1220339) | [1213267, 1213860) | Secret-exchange mutation and lifetime query |
| S7 | [1221419, 1222709) | [1214940, 1216230) | Secret-path extraction, mutation variables, token installation |
| S8 | [1225359, 1225489) | [1218880, 1219010) | Sign-in drawer lazy-loads chunks 6, 44, 5, 11, 66; module `yu8+` |
| S9 | [1231229, 1233429) | [1224750, 1226950) | MCard callback inputs and token/location handling |
| S10 | [1264762, 1268322) | [1258100, 1261660) | Auth header precedence, refresh/retry, failure cleanup |
| S11 | [1254532, 1255142) | [1247960, 1248570) | GraphQL URL derived from `/graphql` and origin |
| S12 | [1264432, 1264992) | [1257770, 1258330) | Browser origin uses `globalThis.location.origin` |
| S13 | [265231, 265441) | [265230, 265440) | Separate `SignOutFromMenu` / `revokeCustomerToken` document |
| S14 | [143071, 143488) | [143070, 143487) | Cart creation helper: skips existing cart ID, otherwise invokes supplied mutation |
| S15 | [124831, 126527) | [124831, 126527) | `6i0m`: `GetCartDetailsAfterSignIn` document |
| S16 | [778361, 781863) | [771959, 775461) | `kSvd.b`: `GetStoreInformationQuery` document |
| S17 | [690175, 690823) | [684620, 685268) | `dhg2`: merged cart's `CheckoutPageFragment` |

Reproduce any excerpt without executing the bundle or reading credentials
(`CAPTURE` = your local capture directory holding the fetched chunk):

```sh
CAPTURE=/path/to/capture   # wherever you re-fetched the public chunk
node --input-type=module -e 'import { readFileSync } from "node:fs"; const source = readFileSync(process.argv[1]); console.log(source.subarray(595139, 597058).toString("utf8"));' "$CAPTURE/mm-asset-client.621acc48af8c317cdd54.js"
```

## Login/token issuance found in public source

The GraphQL below preserves operation names, variable types, arguments, and
selected fields. Whitespace is normalized and source comments omitted. These are
**static extraction**, not executable operator instructions or live proof.

### Ordinary email/password sign-in: lazy discovery closed

The primary supplied HTTP-200 public captures in
`<capture>/mm-public-auth/`; their HTTP status is supplied
provenance, not independently replayed here. Homepage L1 names runtime URL
`https://cdn-b2c.mmpro.vn/runtime.33fbd54608f40e620179.js` (saved as `runtime.js`)
and the same MAIN filename as above. Runtime L2 sets webpack public path to
`https://cdn-b2c.mmpro.vn/` and maps chunk IDs to the hashes below. Thus each exact
chunk URL is that public path plus its literal filename; no guessed URLs or
additional public fetches are needed for this sign-in chain.

| Local public asset | UTF-8 bytes / UTF-16 units | SHA-256 |
| --- | --- | --- |
| `homepage.html` | 69699 / 69619 | `a822eb2ffa13ca9a017f0d68b42d08a92a6ee897c4f28646e26040a64e7f3ae6` |
| `runtime.js` | 6020 / 6020 | `037eaef02a64ebc0fb30ce7237b06cca61c61d9bef3378d041731da7f26ec4b4` |
| `6.fc78da1e934b65e93d7c.js` | 32107 / 32107 | `d8eaf203a1704463652a52a679e411553e32453d711f971f9acf1fdcc66a3943` |
| `44.908ab587731c636828e7.js` | 14298 / 14298 | `ba81e3ef8b9a35beedf5616c6ef49ae927814b300e9d2d7c0824d6056c50f113` |
| `5.ff26e8164141544367c7.js` | 28896 / 28896 | `4becf9278d7f8a5eed984f008e7bffb72df38026c15197f46ccc16bf0b024865` |
| `11.dd7122ec3056d7a384e1.js` | 19647 / 19647 | `2b4ee623d2403b399d4bf0a1c77605a5cd55fcb7bd9ea51ec7effc393bc444b0` |
| `66.5591a41a0ebc11016127.js` | 26346 / 26346 | `7808926755292cace32d11f8ffa413303140befea4e9ea2c1be08e6361656da0` |

All five chunks are ASCII, so their byte and UTF-16 offsets coincide. L ranges
use the same zero-based, end-exclusive convention as S ranges.

| ID | Asset | UTF-8 bytes | UTF-16 units | Evidence |
| --- | --- | --- | --- | --- |
| L1 | homepage | [68799, 69038) | [68719, 68958) | Runtime, vendor, MAIN script tags |
| L2 | runtime | [0, 6020) | [0, 6020) | Public path and exact chunk hash map |
| L3 | chunk 44 | [14195, 14294) | [14195, 14294) | `yu8+` re-exports `Upw1` |
| L4 | chunk 66 | [21203, 22797) | [21203, 22797) | `Upw1`: `SIGN_IN`/default renders `+GNV` |
| L5 | chunk 11 | [386, 10934) | [386, 10934) | `+GNV`: submit, success/error branches, form and reCAPTCHA widget |
| L6 | chunk 11 | [10935, 12739) | [10935, 12739) | `3sxy`: sign-in, customer read, create-cart and merge documents |
| L7 | chunk 6 | [28540, 31745) | [28540, 31745) | `MsnC`: reCAPTCHA config, script, execution and header |
| L8 | chunk 6 | [27779, 28273) | [27779, 28273) | `Hqt8`: conditional widget container |
| L9 | chunk 5 | [14653, 19173) | [14653, 19173) | `SaUs`: separate account-creation login, not ordinary sign-in |

S8 → L3 → L4 → L5/L6 resolves the previously uninspected drawer path without
executing downloaded JavaScript. The email/password form submits this exact
operation through Apollo (`fetchPolicy: "no-cache"`), to the browser GraphQL
endpoint described by S11/S12:

```graphql
mutation SignIn($email: String!, $password: String!) {
  generateCustomerTokenV2(email: $email, password: $password) {
    token
    location_user {
      region_id city city_code district district_code ward ward_code
      address store_view_code
    }
  }
}
```

The supplied variables are exactly `{ email, password }`, both non-null GraphQL
`String!`; the UI applies required-field validation to both. No challenge ID,
OTP, success flag, error field, or refresh token is selected by this operation.
Do not substitute `generateCustomerToken`: chunk 5 L9 uses it in the distinct
`SignInAfterCreate` operation after customer creation.

**Challenge/config branch (L5, L7, L8).** The login hook calls `MsnC` with
`currentForm: "CUSTOMER_LOGIN"`, `formAction: "signIn"`. Its
`GetReCaptchaV3Config` query selects
`recaptchaV3Config { website_key badge_position language_code forms }`.
Enablement requires no config `Error`, a nonempty website key, and
`forms.includes("CUSTOMER_LOGIN")`. The helper constructs
`https://www.google.com/recaptcha/api.js` with `badge`, `render` (key, or
`explicit` for inline), `onload=onloadRecaptchaCallback`, and optional `hl`.
Inline mode renders an invisible widget. If `grecaptcha` is marked available,
submission awaits `grecaptcha.execute(widgetIdOrKey, { action: "signIn" })`
and spreads `{ context: { headers: { "X-ReCaptcha": result } } }` into mutation
options. Execution errors are caught and return `{}`; unavailable reCAPTCHA
also returns `{}`. Availability initially checks the global, so this is not a
strict per-submit enablement gate. Loading disables the submit button; the inline
container renders only when enabled, inline, and ready. This proves a CAPTCHA
integration, not current server enablement, enforcement, acceptance without the
header, or absence of further server-side challenges. No config endpoint was read.

**Success and follow-up calls (L5, L6, S2, S14), in source order:**

1. Set signing-in state; await CAPTCHA data and `SignIn`; dereference
   `data.generateCustomerTokenV2.token` directly, without a separate success test.
   Optionally save email plus AES-transformed password to browser
   `customer_information` when “Save information” is enabled; close account drawer
   and send login analytics. Operator tooling must not copy password persistence.
2. Await `setToken(token, configuredLifetime)` or its default, then
   `YRuz.d(client)` = **`GenerateAuthSession` mutation** (S2). Its null/error result
   is ignored: the chain continues. This is separate session issuance, not the
   email/password response, not refresh, and not a cart operation. Its access token
   takes header precedence over `signin_token` (S10); only access token/session ID
   are persisted by this helper, despite selecting `refresh_token`/`expires_in`.
3. Clear cart/customer Apollo caches, remove the local cart, then invoke
   `createCart({ fetchCartId })` backed by **`CreateCartAfterSignIn`**, selecting
   `cartId: createEmptyCart`. S14 can skip issuance if a state/storage cart ID
   exists; this is a mutation-capable call, not a read-only customer-cart lookup.
   Retrieve the resulting cart ID. If the pre-login cart ID was truthy, await
   **`MergeCartsAfterSignIn($sourceCartId: String!, $destinationCartId: String!)`**,
   passing old ID as `source_cart_id` and resulting ID as `destination_cart_id`.
   It selects `id`, `items { uid }`, and `...CheckoutPageFragment` (S17), adding
   `items { product { uid stock_status } }`, `total_quantity`, and
   `available_payment_methods { code }` (plus repeated `id`/item `uid`).
   Merge exceptions alone are swallowed. Creation/merge must not enter auth tooling.
4. If `location_user` exists, save browser `customer_address` only when city code,
   ward code, and address are truthy. If a nonempty store view differs from stored
   value, run `GetStoreInformationQuery($storeViewCode: String!)` (S16), selecting
   `storeInformation(store_view_code: $storeViewCode) { source_code name address }`;
   save view/store when `source_code` exists,
   but set the reload flag regardless of that field. No address-write mutation
   appears in this ordinary callback; these are local address/store changes.
5. Unless reload-flagged, navigate to the redirect URL; await user-details fetch
   and cache-only `GetCustomerAfterSignIn`. It selects `customer_uid`, `email`,
   `firstname`, `is_subscribed`, and
   `custom_attributes(attributeCodes: ["company_user_phone_number"]) { code ... on AttributeValue { value } }`.
   Read that phone attribute, save `lastAPICallDate`, attempt sign-in/identify
   analytics, dispatch `USER_SIGN_IN`, fetch cart details with
   `GetCartDetailsAfterSignIn($cartId: String!)` (S15),
   then `location.assign(redirect)` if reload-flagged. These reads/analytics are
   not token issuance or renewal prerequisites established for an operator client.

**Failure branches (L5).** The broad submit catch only clears signing-in state;
it does not roll back tokens or completed session/cart/storage side effects.
Apollo sign-in `error` triggers a dismissible 7-second toast using `error.message`;
user-details errors populate the form error map. Missing/null login data and
post-login exceptions also reach the broad catch, potentially after partial
success. No dedicated OTP/MFA challenge continuation appears in this handler;
GraphQL/server errors may still represent challenges not modeled here.

### MCard callback exchange (S1, S9)

```graphql
mutation generateLoginMcardInfo(
  $hash: String, $token: String, $store: String!, $custNo: String!,
  $phone: String!, $custNoMM: String!, $custName: String!
) {
  generateLoginMcardInfo(input: {
    hash: $hash, token: $token, store: $store, cust_no: $custNo,
    phone: $phone, cust_no_mm: $custNoMM, cust_name: $custName
  }) {
    customer_token
    location_user {
      region_id city city_code district district_code ward ward_code
      address store_view_code
    }
  }
}
```

The callback reads URL parameters `token`, `hash`, `store`, `phone`, `cust_no`,
`cust_name`, `cust_no_mm`, `callback_url`, and `lang`. The call sends `hash` when
truthy, otherwise `token`, plus the five required identity/store variables.
Success reads `data.generateLoginMcardInfo.customer_token` and `location_user`,
then calls `setToken(token, customerAccessTokenLifetime)` when lifetime is truthy,
otherwise `setToken(token)`. It also handles store/address-related browser state.

Unknown: where a legitimate operator obtains these handoff values, signature/hash
rules, single-use/expiry behavior, required cookies, MFA, and backend side effects.
Do not fabricate an email/password mutation or treat this as a safe CLI login.

### Secret-path exchange (S6, S7)

```graphql
mutation generateCustomerTokenBySecret($input: GenerateCustomerTokenBySecretInput!) {
  generateCustomerTokenBySecret(input: $input) {
    customer_token
  }
}
```

The route contains `/loginascustomer/login/index/secret/`. The component extracts
`pathname.split("/secret/")[1].split("/")[0]`, sends
`variables: { input: { secret: extractedValue } }`, reads
`data.generateCustomerTokenBySecret.customer_token`, then calls `signOut({})`
before installing the new token. The lifetime choice matches the MCard callback.
This is a distinct login-as-customer route, not evidence of ordinary operator login.
Secret issuance, authorization, expiry, replay restrictions, and MFA are unknown.

S1 also declares `createCustomerFromMcard($input: CustomerCreateInput!)`, selecting
`customer_token` and `customer { email firstname }`. This creates a customer;
it is not a renewal fallback. Its input structure is not established here.
S1 declares `CreateCartAfterSignIn` (`cartId: createEmptyCart`) and
`MergeCartsAfterSignIn` (`mergeCarts`); their presence must not authorize cart
creation/merging in operator tooling. No browser login chain is executed.

## Expiry: customer token versus auth session

### Customer bearer token (S1, S3–S7, S9)

```graphql
query GetStoreConfigData {
  storeConfig {
    store_code
    minimum_password_length
    customer_access_token_lifetime
  }
}
```

`setToken(token, lifetime = 1)` stores `signin_token` with TTL `3600 * lifetime`.
The expiry check uses stored `ttl` and `timeStored`:
`ttl && Date.now() - timeStored > 1000 * ttl` calls sign-out. Another middleware
computes `Math.max(1000 * ttl - (Date.now() - timeStored), 0)` and schedules
sign-out when remaining time fits a signed 32-bit timeout.

This proves the **client treats the config value as hours**, defaulting to one
hour when omitted. It does not prove the server's lifetime, a current configured
value, JWT format/claims, or refresh support for `signin_token`. The config query
does not return an issuance timestamp or refresh token. The account module does
not store TTL; it detects invalid/expired credentials through live read failures.

### Separate auth session (S2)

```graphql
mutation GenerateAuthSession {
  generateAuthSession {
    access_token
    token_type
    expires_in
    session_id
    refresh_token
  }
}
```

The helper invokes `client.mutate({ mutation, fetchPolicy: "no-cache" })` with
no variables, stores `access_token` as `mmpro_auth_access_token` and `session_id`
as `mmpro_auth_session_id`, and returns the payload; failures return `null`.
L5 proves it is awaited immediately after ordinary login token installation;
whether the backend accepts it is unverified. `expires_in` is selected, but units, current value,
server enforcement, and proactive renewal timing remain unverified.

## Refresh exists, but is cookie-dependent client behavior (S2, S10)

Exact query string passed to browser fetch:

```graphql
mutation { refreshAuthSession { success access_token token_type expires_in session_id rotated error message } }
```

Static request construction:

- URL: relative `/graphql`; method: `POST`; `credentials: "include"`.
- Headers: `{ "Content-Type": "application/json" }`.
- Body: `JSON.stringify({ query: queryStringAbove })`; no variables, explicit
  authorization header, store header, or `refresh_token` parameter.
- The helper reads `store_view_code` but does not put it in this request.
- Non-OK HTTP, nonempty GraphQL errors, or missing/falsy `success` or
  `access_token` throw. Success stores the returned access token/session ID.
- A shared in-flight promise deduplicates refresh and resets in `finally`.
- `refresh_token` occurs once in this bundle: as a selected generation field.
  No explicit refresh-token argument or persistence is shown in this helper.

S10 chooses bearer authorization from `mmpro_auth_access_token` first, falling
back to `signin_token`. Its unauthorized handler recognizes HTTP 401 or GraphQL
authentication markers, attempts this refresh when an auth-session token exists,
then forwards the original operation once with the new access token. Login/logout
operations are excluded. This is **observed SPA source logic, not behavior to copy
into MCP**; the separate SPA retry link is not an operator safety guarantee.

The browser uses its current origin (S12); GraphQL URL defaults to
`new URL("/graphql", origin)` (S11). This does not establish a portable Node
refresh flow: `credentials: "include"` relies on browser cookie handling, whereas
the existing account reader sends only `Authorization` and `store` to fixed
`https://online.mmvietnam.com/graphql`. The static review alone did not establish
cookie names, attributes, issuance, rotation, invalidation, or cookie-free bearer
compatibility. The supplied primary observation above now establishes Secure
`mmpro_rt` issuance and one successful cookie-based refresh with cookie-free bearer
proof, not rotation, expiry-unit, or invalidation semantics. Do not invent a
bearer-only refresh or add cookies to the auth schema.

S2 also declares `LogoutAuthSession { logoutAuthSession { success error } }`;
its helper swallows logout errors. S13 declares
`SignOutFromMenu { revokeCustomerToken { result } }`. Both are mutations; neither
was called. They are distinct contracts, not interchangeable renewal steps.

## MFA and implementation decision

**Static login/CAPTCHA flow established; supplied primary observation permits
bounded setup.** The five previously missing chunks are inspected: L5/L6 identify the
ordinary login operation and branches, L7/L8 establish reCAPTCHA. The earlier
MAIN-only symbol search was not sufficient evidence. No explicit OTP verification,
MFA enrollment, or MFA continuation is established by this ordinary handler.
That does not prove MFA absent: server enforcement, error-driven challenges, and
the separate MCard/social identity-provider paths require their own evidence.

`scripts/auth-setup.mjs` now provides operator setup/manual re-login, with fake-only
`scripts/auth-setup.test.mjs`, `npm run auth:setup`, and focused coverage wired first
into `npm test`. Existing account tools remain unchanged, read-only, fail-closed,
and without automatic mutation retries. The CLI is not a credential importer and
does not merely trust a returned token: a separate cookie-free read proves it.

Storage compatibility: exactly two JSON
keys `{ "authorization": "Bearer <token>", "store": "b2c_<digits>_vi" }`;
printable non-space bearer token; 1–8 store digits; at most 16 KiB. Path precedence
is `MM_AUTH_FILE`, then `$XDG_DATA_HOME/mm-mcp/auth.json`, then
`~/.local/share/mm-mcp/auth.json`. The reader requires an owned private parent
directory, an owned regular mode-0600 file, and rejects immediate parent/file
symlinks. The new writer enforces an owned mode-0700 immediate parent, owned
mode-0600 regular existing target, and no symlink at any ancestor or target. Missing
directories are created mode 0700. An exclusive mode-0600 temporary file is written,
synced and closed; parent identities and target identity are checked again before
atomic rename. Errors before rename preserve old credentials and remove the temp
file where possible. Paths must reside under trusted ancestors; Node path-based
filesystem APIs are not a defense against hostile concurrent processes running
as the same OS user. No password or cookie is persisted.

## Current execution contract and deferred gates

- Input is one bounded UTF-8 JSON object on stdin, exactly `email`, `password`,
  `store`. Arguments, invalid credentials, invalid stores, and control characters
  are rejected. Stdin and each request have 10-second deadlines; input/responses
  are bounded to 16 KiB. Bearer token is printable non-space ASCII, at most 8192
  characters, so saved auth fits the existing 16 KiB ceiling.
- All requests are POST to the fixed origin, selected Store header, redirect
  rejection and omitted cookie credentials. Configuration and login never send
  Authorization; only proof uses the returned Bearer. Set-Cookie is not retained.
- Config query selects `recaptchaV3Config { website_key forms }`. Only a verified
  config whose forms omit `CUSTOMER_LOGIN` permits login. Enabled form stops with
  `CHALLENGE_REQUIRED`; malformed/missing/failed config stops with
  `CONFIG_UNVERIFIED`. No bypass or challenge-solving path exists.
- Exactly one `SignIn` mutation is allowed, followed by
  `customer { __typename } storeConfig { store_code }`. Login/proof rejection,
  GraphQL errors (including partial-data errors), timeouts, malformed responses,
  invalid bearer, or store mismatch stop without storage changes. Errors expose
  fixed codes only, never remote text, credential values, or filesystem paths.
- No browser, account creation, cart creation/merge, session issuance, automatic
  retry, cookie persistence, or refresh is implemented. Recovery is explicit
  operator re-login. MFA/challenge policy beyond the supplied observation, actual
  expiry units/lifetime, cookie rotation/storage and automatic refresh remain
  unestablished or deferred. Future work needs separate authorization and proof;
  this report grants no permission for additional live calls.

## Historical discovery validation

- Continuation: all seven public-capture sizes/hashes, L1–L9 byte/UTF-16 mappings,
  runtime chunk URL mappings, module export chain, and S14–S17 ranges checked
  offline. Downloaded JavaScript was read as text, never executed. Only this report
  and the README lifecycle summary changed; no auth/private/config reads or live
  mutations. Prior test outcomes below are retained history, not rerun claims.

- Source-evidence checks passed: SHA-256, lengths, all 13 byte/UTF-16 range
  mappings, exact refresh query, token distinctions, and absence of CLI artifacts
  in the earlier MAIN-only review.
- `git diff --check` and the new document's no-index whitespace check passed.
- `npm test` exited 1: stdio 0/24, null responses/timeouts; later suites were not
  reached by the chained npm command. A minimal child-Node `spawnSync` probe
  returned `error.code: EPERM` and empty stdout in this executor. A direct shell
  invocation of the server answered initialization successfully. Subprocess-based
  validation is blocked here; the full offline gate is not green.
- Separately invoked offline suites: catalog 40/40; account 33/33, two live-only
  checks skipped; fake-child gate harness 1/6, failing on responses/timeouts.
- Focused new CLI tests: not applicable, implementation withheld. Runtime source,
  existing scripts, and `package.json` have no diff. No live checks were run.

These discovery results predate the CLI and are not current implementation gate
results. Current implementation validation is recorded separately below.

Rerun `npm test` in an executor that permits the suite's child processes before
claiming the existing offline gate passes. No unrelated runtime/test edits made.

## Historical bounded CLI validation (superseded)

The restricted worker results below are historical, not the current gate state.
Primary host re-ran all six suites on 2026-11-01 under synthetic HOME/XDG:
212 checks passed, two live-only checks skipped, exit 0. A seventh suite
(`scripts/cart.test.mjs`, 20 checks) was added the same day, so the current gate is
eight suites, 255 pass / 2 skip — see [testing.md](testing.md), which is authoritative.

- Focused fake-only suite: `node scripts/auth-setup.test.mjs` passed 74/74 checks.
  Covers exact requests, no login cookies/authorization, CAPTCHA/config fail-closed,
  malformed input, rejected login, bearer/proof/store rejection, redaction, bounds,
  timeouts, private filesystem/symlink checks, and write-failure preservation.
- `npm test` exited 1 after the focused suite passed: stdio 0/24 with null
  replies/timeouts; chained later suites were not reached. A minimal Node
  `spawnSync` child probe returned `error.code: EPERM` and empty stdout/stderr.
  Full offline gate is **not green**; primary host must rerun it.
- Separately run offline suites: catalog 40/40; account 33/33, two live-only
  skipped; fake-child harness 1/6 with response/timeouts. No unrelated fixes made.
- Direct CLI smoke checks: invalid stdin and argv both exit 1 with only
  `INVALID_INPUT`, before network or storage. Node syntax checks and tracked
  `git diff --check` passed; no whitespace diagnostics for the added files.
- No live calls, private reads, commit, or push performed.
