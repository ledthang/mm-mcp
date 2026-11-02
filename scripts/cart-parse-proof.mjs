#!/usr/bin/env node
// Does the endpoint PARSE the exact read document this server ships? This runner answers that
// with real bytes and NO credentials: every request is ANONYMOUS and READ-ONLY, so a proof run
// cannot change any cart and never opens an auth file.
//
// Why this exists (2026-11-01): the first authorized live attempt reached the gate and the
// PRE-READ failed BEFORE any mutation — HTTP 400 {"errors":[{"message":"Syntax Error:
// Expected Name, found <EOF>"}]} — because CART_SNAPSHOT_QUERY was missing one closing brace.
// `npm test` could not see that: a fake answers whatever it is told, so a malformed document
// "passed" forever. Brace balance in scripts/cart.test.mjs catches the class offline; THIS
// script proves it against the real parser (no GraphQL dependency is installed, and adding one
// just to parse-check would be a new dependency for nothing — the endpoint IS the parser).
//
// Scope, stated exactly:
//   sent     = the two READ documents only (CART_SNAPSHOT_QUERY, and CART_QUERY from
//              src/account.mjs), anonymous, 3 requests total (2 real + 1 negative control).
//   proven   = "the upstream parser accepts the document" <=> the answer carries no
//              "Syntax Error". A 403 authorization refusal PROVES parsing: the query reached the
//              field resolver, which the server can only do after parse + validation succeed.
//   NOT proven = that any cart was read, that anything was written, or that any customer's
//              state is known. Nothing here is authenticated, so nothing here can know a cart.
//   NOT sent   = the three MUTATION documents (addProductsToCart / updateCartItems /
//              removeItemFromCart). Dispatching one to check its syntax WOULD BE A WRITE, and
//              this runner must make none. Their upstream parse is proven only when an operator
//              runs scripts/cart-live.mjs (which is authorized, not this).
//
// Gate: MM_LIVE_PARSE=1 must be set, else one machine-readable `blocked` line and exit 0
// (nothing proven, nothing changed) — the same opt-in discipline as MM_LIVE_PARSE in
// scripts/account.test.mjs. Requests are POST /graphql with { content-type } only: no
// Authorization header exists on this path, so no credential can leak here by construction.
const URL_PATH = "https://online.mmvietnam.com/graphql";
const TIMEOUT_MS = 25000;
const MAX_BYTES = 2 * 1024 * 1024;

const SYN = /Syntax Error/i; // the exact category word this backend prints for parse failures
const AUTH_REFUSED = /logged in customer|authentication required|SERVER_ERROR: Can't load|Could not load cart/i;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

let checks = 0, failures = 0, requests = 0;
function check(name, facts) {
  checks += 1;
  try {
    const f = facts();
    console.error(`PASS ${name} ${JSON.stringify(f)}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL ${name} :: ${(e && (e.message || e.code || e.name)) || "ERR"}`);
  }
}

// One anonymous POST of exact bytes. Never throws for a refusal: a refusal is data here.
// Returns {status, errors[]} where errors[] are the upstream error MESSAGES only (capped),
// never headers, never bodies beyond that, and never a credential (none was sent).
async function post(query) {
  requests += 1;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" }, // anonymous: no Authorization header at all
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    const parts = [];
    let size = 0;
    const reader = res.body ? res.body.getReader() : null;
    if (reader) {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
        parts.push(Buffer.from(r.value));
      }
    }
    const text = Buffer.concat(parts).toString("utf8");
    let errors = [];
    try {
      const p = JSON.parse(text);
      if (isObj(p) && Array.isArray(p.errors)) {
        errors = p.errors.filter(isObj).map((e) => String(e.message ?? "").slice(0, 200));
      }
    } catch { errors = ["<answer was not JSON>"]; }
    return { status: res.status, errors };
  } catch {
    return { status: 0, errors: ["<no answer: timeout or transport failure>"] };
  } finally {
    clearTimeout(timer);
  }
}

// A document PARSES when no answer error says "Syntax Error". Everything else (empty cart,
// "allowed for logged in customer") means parse + validation succeeded.
const parsed = (ans) => !ans.errors.some((m) => SYN.test(m));

async function main() {
  if (process.env.MM_LIVE_PARSE !== "1") {
    console.log(JSON.stringify({ status: "blocked", reason: "MM_LIVE_PARSE!=1 (no request was made: nothing proven, nothing changed)", proven: false, requests_made: 0 }));
    process.exit(0);
  }

  const { CART_SNAPSHOT_QUERY } = await import("../src/cart.mjs");
  const { CART_QUERY } = await import("../src/account.mjs");

  // ---- NEGATIVE CONTROL FIRST: a document known NOT to parse must be detected. This is the
  // exact byte-level shape that failed live (the shipped query with its final `}` removed, so
  // the text ends inside `customerCart { ...` => "Expected Name, found <EOF>").
  const ansBroken = await post(CART_SNAPSHOT_QUERY.slice(0, -1));
  check("negative control: one brace removed from the shipped read doc => the REAL parser reports Syntax Error", () => {
    if (!ansBroken.errors.some((m) => SYN.test(m))) {
      throw new Error(`expected "Syntax Error", saw HTTP ${ansBroken.status} ${JSON.stringify(ansBroken.errors).slice(0, 160)}`);
    }
    return { http: ansBroken.status, syntax_error: true, detected: true };
  });

  // ---- the documents actually shipped, exact bytes, anonymous, read-only
  for (const [label, q] of [
    ["CART_SNAPSHOT_QUERY (src/cart.mjs pre/post read)", CART_SNAPSHOT_QUERY],
    ["CART_QUERY (src/account.mjs read, reused by the cart tools)", CART_QUERY],
  ]) {
    const ans = await post(q);
    check(`${label}: upstream parser accepts the exact shipped bytes`, () => {
      if (ans.status === 0) throw new Error(`no answer: nothing proven (${JSON.stringify(ans.errors).slice(0, 120)})`);
      if (!parsed(ans)) throw new Error(`parser rejected the document: HTTP ${ans.status} ${JSON.stringify(ans.errors).slice(0, 200)}`);
      return {
        http: ans.status,
        syntax_error: false,
        bytes: q.length,
        answered_as: ans.errors.length === 0 ? "data (authenticated path not used here)"
          : AUTH_REFUSED.test(ans.errors.join(" ")) ? "anonymous request refused by authorization (parse + validation OK)"
          : `other validation answer (${JSON.stringify(ans.errors).slice(0, 120)})`,
        cart_read: false, // anonymous: no customer's cart was observed, and none is claimed
      };
    });
  }

  console.log(`${checks - failures}/${checks} checks passed`);
  console.log(`${requests} anonymous read-only requests made; no credential sent; no mutation dispatched`);
  process.exit(failures ? 1 : 0);
}

main();
