#!/usr/bin/env node
// Live WRITE gate for the cart tools — the operator runner, NOT part of `npm test`.
//
// STATUS 2026-11-01: NOT LIVE-VERIFIED. One authorized attempt was made and it stopped
// BEFORE any mutation: the tool's pre-read answered "Syntax Error: Expected Name, found
// <EOF>" (the shipped CART_SNAPSHOT_QUERY was missing one closing brace). No ginger, nothing
// added, mutation_count 0. The query is fixed and its syntax is now proven against the real
// parser (scripts/cart-parse-proof.mjs, anonymous/read-only: 3/3). Until an operator runs
// this gate and sees an exact increment, everything in src/cart.mjs is proven only by fakes
// (scripts/cart.test.mjs) and by that parse proof.
//
// Gate (all four required, else NOTHING happens — no child, so zero requests):
//   MM_MCP_LIVE=1
//   MM_CART_WRITE_APPROVED=i_understand_this_changes_the_cart
//   MM_LIVE_SKU=<exact sku to add>            MM_LIVE_QTY=<finite > 0>
// Blocked runs print one machine-readable line and exit 0: nothing proven, nothing changed —
// a different fact from "verified", and the line says so.
//
// Approved run: ONE child, strictly serial, and the write is dispatched ONLY when a baseline
// was actually observed:
//   initialize -> tools/list (10) -> mm_get_cart (baseline)
//     baseline refused/unreadable => NO write dispatched (a write with no baseline cannot be
//       measured afterwards: any post-read would be uninterpretable), gate fails
//     baseline observed          => exactly ONE mm_add_to_cart -> mm_get_cart (post-read)
//   -> stdin close, wait for real 'close'.
// writeCalls counts the write requests this gate issues; it is reported, never assumed, so
// "never retried" is measured. There is no compensating remove here: a gate that also deleted
// would be an unapproved SECOND mutation. The last line says what the cart holds so the
// operator can undo it by hand.
//
// Claims are checked against OBSERVED state, never accepted because the tool said so:
//   applied  -> needs post_qty == pre_qty + qty for that sku AND no other row moved
//   rejected -> needs the cart unchanged (a "refusal" that moved the cart is not trustworthy)
//   unknown  -> claims nothing, so nothing here can contradict it
// NOT `post_qty >= qty`, which an earlier version ORed in and which passed a cart that never
// moved (pre 5 -> post 5). Partial, over, confounded, unchanged corroborate nothing.
//
// Dispatch accounting separates two facts a previous version collapsed:
//   mutation_count 0 / dispatched false  => PRE-DISPATCH refusal. Nothing reached the
//     backend: FAILED ACCEPTANCE naming the code. There is no duplicate flag to check — the
//     adapter emits `duplicate_intent` only on a guard hit, so asserting it `false` here
//     would assert a field that does not exist (it came back undefined).
//   mutation_count 1 / dispatched true   => one mutation reached the backend; only here can
//     "exactly one, not a replay" be claimed.
//
// Harness reused, not rewritten: spawnGate comes from scripts/account-live.mjs (bounded
// waits, strict envelope, orphan frames counted, 2 MiB cap, real-close semantics). The write
// call gets CART_MUTATION_TIMEOUT (80 s) because that one MCP call wraps pre-read + one
// mutation + post-read (~75 s upstream); everything else uses the 30 s default.
// stdout: "PASS <id> <safe facts>" / "FAIL <id> <fixed why>" + summary lines. Safe facts =
// booleans / counts / store code / verdict / codes only — never the token, never items.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGate, CART_MUTATION_TIMEOUT } from "./account-live.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");

const PV = "2024-11-05";
const APPROVAL = "i_understand_this_changes_the_cart";
const QTY_EPS = 1e-9; // quantities are floats: exact == would be brittle for 0.1/0.2 arithmetic

// ------------------------------------------------ gate: no approval => no child => zero requests
// Everything is refused BEFORE the child is spawned, so a refused run makes zero requests by
// construction. The reason is one fixed string naming exactly what is missing.
export function gateBlock(env = process.env) {
  if (env.MM_MCP_LIVE !== "1") return "MM_MCP_LIVE!=1 (live write gate not enabled)";
  if (env.MM_CART_WRITE_APPROVED !== APPROVAL) return "MM_CART_WRITE_APPROVED missing or not exactly the approval phrase";
  if (typeof env.MM_LIVE_SKU !== "string" || env.MM_LIVE_SKU === "") return "MM_LIVE_SKU not given (which sku may the gate put in the cart?)";
  const q = Number(env.MM_LIVE_QTY);
  if (!(Number.isFinite(q) && q > 0)) return "MM_LIVE_QTY not a finite number > 0";
  return null;
}

// Observed quantity of a sku across the cart rows (a sku split over rows still has one
// observable total, which is what the customer would see).
function qtyFor(cart, sku) {
  const rows = cart && Array.isArray(cart.items) ? cart.items : [];
  return rows.reduce((s, l) => s + (l && l.sku === sku && Number.isFinite(l.quantity) ? l.quantity : 0), 0);
}

// Everything else in the cart, as a comparable fingerprint: any movement here while our sku
// moved exactly means SOMEONE ELSE acted at the same time and attribution is not possible.
const otherFingerprint = (cart, sku) =>
  JSON.stringify((cart && Array.isArray(cart.items) ? cart.items : [])
    .filter((l) => l && l.sku !== sku)
    .map((l) => [l.uid ?? "", l.quantity ?? null]));

// The actual check the gate runs on the two reads. `kind` names what was observed; it is
// never inferred from HTTP status or from the tool's own wording.
export function addObserved({ pre, post, sku, qty }) {
  if (!pre || !post) return { kind: "unreadable (a read failed or was lost)", corroborated: false, pre_qty: null, post_qty: null, delta: null, others_changed: null };
  const preQty = qtyFor(pre, sku);
  const postQty = qtyFor(post, sku);
  const delta = postQty - preQty;
  const othersChanged = otherFingerprint(pre, sku) !== otherFingerprint(post, sku);
  const exact = Math.abs(delta - qty) <= QTY_EPS;
  let kind;
  if (Math.abs(delta) <= QTY_EPS) kind = othersChanged ? "unchanged for this sku (other rows moved)" : "unchanged";
  else if (delta < 0) kind = "decreased";
  else if (!exact) kind = delta < qty ? "partial (less than requested)" : "over_increment (more than requested)";
  else kind = othersChanged ? "exact increment but other rows moved (confounded)" : "exact increment";
  return { kind, corroborated: kind === "exact increment", pre_qty: preQty, post_qty: postQty, delta, others_changed: othersChanged };
}

// Whether the tool's claimed verdict is corroborated by what the two reads show.
//   applied  -> needs the exact increment and nothing else moving
//   rejected -> needs the cart unchanged (a "refusal" that moved the cart is not trustworthy)
//   unknown  -> claims nothing about the outcome, so nothing here can contradict it
//   anything else -> not part of the vocabulary, so never accepted
export function claimSupported(verdict, observed) {
  if (verdict === "unknown") return true;
  if (verdict === "applied") return observed.kind === "exact increment";
  if (verdict === "rejected") return observed.kind === "unchanged";
  return false;
}

// A read outcome is one of three facts, never conflated:
//   null            => LOST (timeout / dead child / bad frame / over-cap): nothing observable
//   {lost_reason}  => same, with the harness's reason carried through
//   <payload>      => a REAL report (isError answers included): its fields must be read
const parseReport = (r) => {
  if (!r || r.ok !== true) return null; // lost: no claim, and nothing observed
  try {
    const p = JSON.parse(r.text);
    return p !== null && typeof p === "object" && !Array.isArray(p) ? p : null;
  } catch { return null; }
};

// Is a read payload a usable cart (items + context + observed_at), or a refusal? A refusal
// names its code; a cart is then not known.
const readable = (p) =>
  p !== null && Array.isArray(p.items) && p.context && typeof p.context.store_code === "string" &&
  typeof p.observed_at === "string" && !Number.isNaN(Date.parse(p.observed_at));

// Runs the gate against one child (the real server for `npm run live:cart`, a FAKE in the
// offline tests). Nothing here is a fixed business value: quantities and verdicts are
// observed, then reported.
export async function runGate({ cmd, env = process.env } = {}) {
  const why = gateBlock(env);
  if (why) return { checks: [], refused: why };
  const sku = env.MM_LIVE_SKU;
  const qty = Number(env.MM_LIVE_QTY);
  // the real credential reaches the child through the operator's own MM_AUTH_FILE; this gate
  // never opens auth.json, so the token never lands here
  const st = spawnGate(env, cmd);
  const checks = [];
  let writeCalls = 0; // write requests issued by THIS gate, counted: never assumed
  const report = (id, facts) => {
    try {
      const f = facts();
      checks.push({ id, ok: true, facts: f ?? {} });
    } catch (e) {
      checks.push({ id, ok: false, why: (e && (e.message || e.code || e.name)) || "ERR" });
    }
  };

  const a0 = st.strict(await st.ask(0, "initialize", { protocolVersion: PV, clientInfo: { name: "cart-live-gate", version: "1" }, capabilities: {} }), 0);
  report("init_ok", () => {
    assert.ok(a0.ok, a0.why);
    assert.equal(a0.fr.result.protocolVersion, PV);
    return { protocol: PV };
  });

  const tl = st.strict(await st.ask(1, "tools/list", {}), 1);
  report("tools_10", () => {
    assert.ok(tl.ok, tl.why);
    const names = tl.fr.result.tools.map((t) => t.name);
    assert.equal(names.length, 10, "ten tools: 2 guest + 5 auth read + 3 cart write");
    assert.ok(["mm_add_to_cart", "mm_update_cart_item", "mm_remove_cart_item"].every((n) => names.includes(n)));
    return { tools: names.length };
  });

  // ---- baseline read. Without it the write is NOT dispatched: a post-read of a cart whose
  // pre-state was never seen cannot corroborate anything, and dispatching anyway would spend a
  // real mutation on an unmeasurable outcome.
  const pre = parseReport(await st.call(2, "mm_get_cart", {}));
  const preOk = readable(pre);
  report("baseline_read", () => {
    assert.ok(pre !== null, "the baseline read was lost (timeout / dead child / bad frame): nothing observable");
    assert.ok(preOk, `baseline read refused: ${pre.code ?? "UNCLASSIFIED (no code in the answer)"}`);
    return { pre_lines: pre.items.length, pre_qty_for_sku: qtyFor(pre, sku), store: pre.context.store_code };
  });

  // ---- exactly ONE write, only when there is a baseline to compare against afterwards
  let added = null;
  let post = null;
  if (preOk) {
    writeCalls += 1; // the ONE write request this gate issues, counted
    added = parseReport(await st.call(3, "mm_add_to_cart", { sku, quantity: qty, confirm: true }, CART_MUTATION_TIMEOUT));
    post = parseReport(await st.call(4, "mm_get_cart", {})); // the only evidence of what happened
  }

  // Dispatch accounting: FAILED ACCEPTANCE unless exactly one mutation reached the backend.
  //   baseline not observed        => the write was never attempted (it could not be measured)
  //   answer lost                => dispatch count unobservable; nothing was retried
  //   mutation_count 0 / dispatched false => PRE-DISPATCH refusal: nothing reached the
  //     backend. There is no duplicate flag on these paths (the adapter omits it), so none is
  //     asserted: a previous version asserted `duplicate_intent === false` on a report where
  //     that field is undefined, which is a claim about a field that does not exist.
  //   mutation_count 1 / dispatched true => exactly one, and it must not be a replay.
  report("dispatch_accounting", () => {
    if (!preOk) assert.fail("no mutation dispatched: the baseline read failed (NO_BASELINE), and a write without a baseline cannot be measured, so it was not attempted and not retried — acceptance failed");
    if (!added) assert.fail("dispatch count unobservable: the write's answer was lost (timeout / dead child / bad frame) — the gate cannot claim exactly one dispatched mutation, and it did not retry");
    const mc = added.mutation_count;
    assert.ok(mc === 0 || mc === 1, `mutation_count must be 0 (refused before dispatch) or 1 (dispatched once), saw ${JSON.stringify(mc)}`);
    if (mc === 0) {
      assert.equal(added.dispatched, false, "a 0-mutation refusal must say dispatched: false");
      assert.ok(typeof added.code === "string" && added.code !== "", `a refusal must name its code, saw ${JSON.stringify(added.code)}`);
      if (added.duplicate_intent === true) {
        // a guard replay and a first refusal are DIFFERENT facts: one repeats an intent the
        // adapter already handled, the other is new. Collapsing them hides which happened.
        assert.fail(`guard replay (${added.code}): an identical intent was already handled or is in flight — nothing dispatched here, so nothing was retried`);
      }
      assert.equal(added.duplicate_intent, undefined, "a first refusal carries no duplicate flag (asserting false would assert a field the server never sends)");
      assert.fail(`pre-dispatch refusal (${added.code}): nothing reached the backend — acceptance failed, and nothing was retried`);
    }
    assert.equal(added.dispatched, true, "mutation_count 1 must say dispatched: true");
    assert.ok(!added.duplicate_intent, "one dispatch, and not a replay of an earlier intent");
    return { mutation_count: 1, dispatched: true, retried: false };
  });

  report("never_retried_by_gate", () => {
    // measured, not assumed: this gate asks for the write at most once per run (0 when the
    // baseline was never observed, 1 otherwise) and never re-issues after a timeout/refusal.
    assert.ok(writeCalls <= 1, `this gate must ask for the write at most once, asked ${writeCalls}`);
    return { gate_asked_for_write: writeCalls, note: writeCalls === 0 ? "no baseline => no write asked at all" : "one tools/call per run; the adapter never auto-retries either" };
  });

  report("post_read", () => {
    if (!preOk) return { skipped: true, note: "no baseline => no write => no post-read asked" };
    assert.ok(post !== null, "the post-read was lost (timeout / dead child / bad frame)");
    assert.ok(readable(post), `post read refused: ${post.code ?? "UNCLASSIFIED (no code in the answer)"}`);
    assert.ok(pre.context.store_code === post.context.store_code, "both reads name one store");
    assert.ok(Date.parse(pre.observed_at) <= Date.parse(post.observed_at), "post-read is not older than the pre-read");
    return { post_lines: post.items.length, post_qty_for_sku: qtyFor(post, sku) };
  });

  report("claim_from_observed_state", () => {
    const o = addObserved({ pre: preOk ? pre : null, post: readable(post) ? post : null, sku, qty });
    const verdict = added && typeof added.verdict === "string" ? added.verdict : "unknown"; // lost/absent says nothing
    assert.ok(["applied", "rejected", "unknown"].includes(verdict), "verdict vocabulary");
    assert.ok(claimSupported(verdict, o), `${verdict} is not corroborated: ${o.kind} (pre ${o.pre_qty} -> post ${o.post_qty}, requested ${qty})`);
    return { verdict, corroborated: true, observed: o.kind, quantity_held: readable(post) ? qtyFor(post, sku) : null };
  });

  report("no_secret_leak", () => {
    assert.ok(!/Bearer |ey[A-Za-z0-9]/.test(JSON.stringify([added, pre, post])), "no credential material in the reports");
    return { clean: true };
  });

  const cl = await st.close();
  report("clean_exit", () => {
    assert.equal(cl.code, 0, "clean exit after stdin close");
    assert.ok(st.stderrClean, "no stderr noise from the server (content never printed)");
    assert.equal(st.orphans, 0, "no unsolicited/duplicate frames");
    return { exit: true, stderr_clean: true };
  });

  return { checks, refused: null };
}

// import as a library => no run; direct run => execute the gate.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { checks, refused } = await runGate({ cmd: [process.execPath, SERVER], env: process.env });
  if (!checks.length) {
    console.log(JSON.stringify({ status: "blocked", reason: refused, proven: false, requests_made: 0, note: "no live cart write: nothing verified, nothing changed" }));
    process.exit(0);
  }
  let passed = 0;
  for (const c of checks) {
    if (c.ok) { passed += 1; console.log(`PASS ${c.id} ${JSON.stringify(c.facts)}`); }
    else console.log(`FAIL ${c.id} ${c.why}`);
  }
  console.log(`${passed}/${checks.length} checks passed`);
  const claim = checks.find((c) => c.id === "claim_from_observed_state");
  // what the cart now holds for the sku, so the operator can undo it by hand
  console.log(`gate sku holds ${claim && claim.ok && claim.facts.quantity_held !== null ? claim.facts.quantity_held : "?"} (this gate adds; it never removes)`);
  process.exit(passed === checks.length ? 0 : 1);
}
