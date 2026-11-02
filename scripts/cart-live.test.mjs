#!/usr/bin/env node
// Offline tests for the cart WRITE live gate (scripts/cart-live.mjs): FAKE children only.
// No real endpoint, no real credential, no network for these checks. Deterministic; every
// wait is bounded by the reused spawnGate harness. Importing the gate launches nothing (its
// runner is argv-guarded), so these exercise the ACTUAL functions the operator runs —
// gateBlock / addObserved / claimSupported / runGate — not a copy of the expression.
//
// Scenarios that matter, each with its call log read back so "one write, never retried" is
// observed rather than asserted from faith:
//   negative control — "applied" claimed while a nonempty cart never moved (pre 5 -> post 5,
//     qty 1): the old `postQty >= preQty+qty || postQty >= qty` passed it (second arm true for
//     any nonempty cart); the gate must FAIL it.
//   baseline refused (the failure seen live 2026-11-01: pre-read answered a Syntax Error) —
//     the gate must name the refusal code and dispatch NOTHING: no mutation is spent when the
//     pre-state was never observed.
//   pre-dispatch refusal (OUT_OF_STOCK) — failed acceptance naming the code, and NOT an
//     assertion about duplicate_intent (that field does not exist on these paths).
//   answer lost (child dies during the write) — reported, never re-issued.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateBlock, addObserved, claimSupported, runGate } from "./cart-live.mjs";

const BASE = mkdtempSync(path.join(os.tmpdir(), "mmcartgate-"));
process.on("exit", () => rmSync(BASE, { recursive: true, force: true }));

let checks = 0, failures = 0;
async function t(name, fn) {
  checks += 1;
  try { await fn(); console.error("PASS " + name); }
  catch (e) { failures += 1; console.error("FAIL " + name + " :: " + (e && (e.message || e.code || e.name || "ERR"))); }
}

// Faithful fake MCP server: answers every method the gate sends in the real envelope shape and
// logs each tools/call in arrival order. Behaviour is env data (SCENARIO + quantities), never a
// fork inside the assertion path. Reads are PHASE-based (before / after the write), because a
// cart is read twice; refusal paths emit exactly the shapes src emits (code + next_step, and
// NO duplicate_intent flag unless it is a guard replay).
const FAKE = `
const rl = require("readline").createInterface({ input: process.stdin });
const fs = require("fs");
const NAMES = ["mm_search_products","mm_get_product","mm_auth_status","mm_get_delivery_context","mm_list_addresses","mm_get_cart","mm_cart_summary","mm_add_to_cart","mm_update_cart_item","mm_remove_cart_item"];
const SC = process.env.FAKE_SCENARIO;
let reads = 0, adds = 0;
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function block(id, payload, isError) { ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: !!isError }); }
function cart(isPost) {
  const qty = isPost ? Number(process.env.FAKE_POST_QTY) : Number(process.env.FAKE_PRE_QTY);
  const other = isPost ? Number(process.env.FAKE_OTHER_POST) : Number(process.env.FAKE_OTHER_PRE);
  const items = [{ uid: "u1", sku: "GATE_SKU", name: "Gate Item", quantity: qty, price_vnd: 10000 * qty, row_total_vnd: 10000 * qty }];
  if (other > 0) items.push({ uid: "u2", sku: "OTHER_SKU", name: "Other Item", quantity: other, price_vnd: 5000 * other, row_total_vnd: 5000 * other });
  return {
    items, total_quantity: items.reduce((s, l) => s + l.quantity, 0),
    totals: { subtotal_excluding_tax_vnd: 0, grand_total_vnd: items.reduce((s, l) => s + l.row_total_vnd, 0), currency: "VND" },
    shipping: { address_count: 1, selected_methods: [], note: "fake" },
    price_status: "cart-observed-not-guaranteed-payable",
    context: { store_code: "b2c_70010_vi", authenticated: true },
    observed_at: new Date().toISOString(),
  };
}
rl.on("line", (line) => {
  let f; try { f = JSON.parse(line); } catch { return; }
  if (!f || f.id === undefined || f.id === null) return;
  const id = f.id;
  if (f.method === "initialize") return ok(id, { protocolVersion: f.params.protocolVersion, serverInfo: { name: "mm-mcp", version: "0.1.0" } });
  if (f.method === "tools/list") return ok(id, { tools: NAMES.map((n) => ({ name: n, description: "fake tool description long enough to pass", inputSchema: { type: "object" } })) });
  if (f.method === "tools/call") {
    const nm = f.params.name;
    fs.appendFileSync(process.env.FAKE_LOG, nm + " ");
    if (nm === "mm_get_cart") {
      const isPost = reads > 0; reads += 1;
      // the real live failure shape (2026-11-01): an ok envelope whose payload is a refusal
      // naming a code — isError true, and NOT a cart
      if (SC === "baseline_syntax_error" && !isPost) return block(id, { tool: nm, code: "GRAPHQL_ERRORS", next_step: "1 upstream error: the query did not parse" }, true);
      // lost = the child goes away without answering: the harness resolves on real 'close'
      if (SC === "baseline_lost" && !isPost) process.exit(0);
      if (SC === "post_lost" && isPost) process.exit(0);
      return block(id, cart(isPost), false);
    }
    if (nm === "mm_add_to_cart") {
      adds += 1;
      if (SC === "child_dies") process.exit(0);
      if (SC === "refused_no_dispatch") return block(id, { tool: nm, verdict: "rejected", mutation_count: 0, dispatched: false, code: "OUT_OF_STOCK", next_step: "sku is out of stock: nothing was dispatched" }, true);
      if (SC === "dup_replay") return block(id, { tool: nm, verdict: "rejected", mutation_count: 0, dispatched: false, duplicate_intent: true, code: "INTENT_IN_FLIGHT", next_step: "an identical write is already in flight" }, true);
      if (SC === "leak") return block(id, { tool: nm, verdict: "applied", mutation_count: 1, dispatched: true, duplicate_intent: false, note: "Bearer eyFAKElookslikeatoken slipped into a report", next_step: "re-read whenever you need a fresh view" });
      return block(id, { tool: nm, verdict: process.env.FAKE_VERDICT || "applied", mutation_count: 1, dispatched: true, duplicate_intent: false, quantity_observed: Number(process.env.FAKE_POST_QTY), next_step: "re-read whenever you need a fresh view" });
    }
    return block(id, { code: "INTERNAL" }, true);
  }
});
rl.on("close", () => process.exit(0));
`;

let seq = 0;
// approval + scenario env in one place; `gateOn` = the gate is OPEN (child spawned),
// `refusedGate` = whatever subset of the approvals, so the gate must not spawn at all.
function gateEnv({ pre, post, otherPre = 0, otherPost = 0, qty, scenario, verdict }) {
  const log = path.join(BASE, `log-${(seq += 1)}.txt`);
  writeFileSync(log, "");
  return { log, env: { PATH: process.env.PATH, MM_MCP_LIVE: "1", MM_CART_WRITE_APPROVED: "i_understand_this_changes_the_cart", MM_LIVE_SKU: "GATE_SKU", MM_LIVE_QTY: String(qty), FAKE_LOG: log, FAKE_SCENARIO: scenario, FAKE_PRE_QTY: String(pre), FAKE_POST_QTY: String(post), FAKE_OTHER_PRE: String(otherPre), FAKE_OTHER_POST: String(otherPost), ...(verdict ? { FAKE_VERDICT: verdict } : {}) } };
}
async function gateOn(sc) {
  const { log, env } = gateEnv(sc);
  const res = await runGate({ cmd: [process.execPath, "-e", FAKE], env });
  const seen = readFileSync(log, "utf8").trim().split(/\s+/).filter(Boolean);
  return { ...res, seen, log };
}
async function refusedGate(env) {
  const { log, env: full } = gateEnv({ pre: 1, post: 1, qty: 1, scenario: "ok" });
  void full;
  const res = await runGate({ cmd: [process.execPath, "-e", FAKE], env: { PATH: process.env.PATH, ...env } });
  return { ...res, seen: readFileSync(log, "utf8").trim().split(/\s+/).filter(Boolean) };
}
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);
const fact = (r, id) => (r.checks.find((c) => c.id === id) || {}).facts;
const why = (r, id) => (r.checks.find((c) => c.id === id) || {}).why;
const APPROVED = { MM_MCP_LIVE: "1", MM_CART_WRITE_APPROVED: "i_understand_this_changes_the_cart" };
const CALLS = ["mm_get_cart", "mm_add_to_cart", "mm_get_cart"];

async function main() {
  // ---- the gate refuses BEFORE any child exists: the call log stays empty, so zero requests
  await t("gate refused: no approval, no child, and the call log proves zero requests", async () => {
    const cases = [
      [{}, /MM_MCP_LIVE!=1/],
      [{ MM_MCP_LIVE: "0" }, /MM_MCP_LIVE!=1/],
      [{ MM_MCP_LIVE: "true" }, /MM_MCP_LIVE!=1/],
      [{ MM_MCP_LIVE: "1" }, /MM_CART_WRITE_APPROVED/],
      [{ MM_MCP_LIVE: "1", MM_CART_WRITE_APPROVED: "yes" }, /MM_CART_WRITE_APPROVED/],
      [{ ...APPROVED }, /MM_LIVE_SKU/],
      [{ ...APPROVED, MM_LIVE_SKU: "" }, /MM_LIVE_SKU/],
      [{ ...APPROVED, MM_LIVE_SKU: "X", MM_LIVE_QTY: "0" }, /MM_LIVE_QTY/],
      [{ ...APPROVED, MM_LIVE_SKU: "X", MM_LIVE_QTY: "abc" }, /MM_LIVE_QTY/],
      [{ ...APPROVED, MM_LIVE_SKU: "X", MM_LIVE_QTY: "NaN" }, /MM_LIVE_QTY/],
      [{ ...APPROVED, MM_LIVE_SKU: "X", MM_LIVE_QTY: "1e400" }, /MM_LIVE_QTY/], // "Infinity" is not a quantity
      [{ ...APPROVED, MM_LIVE_SKU: "X" }, /MM_LIVE_QTY/],
    ];
    for (const [env, re] of cases) {
      const r = await refusedGate(env);
      assert.deepEqual(r.checks, [], "a refused gate runs no checks");
      assert.deepEqual(r.seen, [], "no child started => the fake logged no call: zero requests by construction");
      assert.match(r.refused, re, "one reason naming exactly what is missing");
    }
    // and the open gate DOES spawn, so the empty-log proof above is not vacuous
    const open = await gateOn({ pre: 1, post: 4, qty: 3, scenario: "ok" });
    assert.equal(open.refused, null);
    assert.deepEqual(open.seen, CALLS);
  });

  // ---- NEGATIVE CONTROL (the defect): applied claimed, a nonempty cart never moved => FAIL
  await t("negative control: 'applied' with an UNCHANGED nonempty cart (pre 5 -> post 5, qty 1) fails the gate", async () => {
    const r = await gateOn({ pre: 5, post: 5, qty: 1, scenario: "ok" });
    assert.ok(failed(r).includes("claim_from_observed_state"), `the claim must be contradicted by the observed state; failures were ${JSON.stringify(failed(r))}`);
    assert.deepEqual(r.seen, CALLS, "pre -> ONE add -> post: it tried once and did not retry");
    // the expression that caused the bug, shown true here so nobody restores it
    assert.equal(5 >= 5 + 1 || 5 >= 1, true, "the OLD check passed this cart — that was the bug");
    const o = addObserved({ pre: { items: [{ sku: "GATE_SKU", quantity: 5 }] }, post: { items: [{ sku: "GATE_SKU", quantity: 5 }] }, sku: "GATE_SKU", qty: 1 });
    assert.equal(o.kind, "unchanged");
    assert.equal(claimSupported("applied", o), false, "the real check does not pass it");
  });

  await t("applied with the exact increment onto an existing line passes end-to-end", async () => {
    const r = await gateOn({ pre: 2, post: 5, qty: 3, scenario: "ok" });
    assert.deepEqual(failed(r), [], "every check passes");
    assert.deepEqual(r.seen, CALLS, "pre -> ONE add -> post, in order");
    assert.equal(fact(r, "claim_from_observed_state").observed, "exact increment");
    assert.equal(fact(r, "claim_from_observed_state").quantity_held, 5);
    assert.equal(fact(r, "dispatch_accounting").mutation_count, 1);
    assert.equal(fact(r, "dispatch_accounting").dispatched, true);
    assert.equal(fact(r, "never_retried_by_gate").gate_asked_for_write, 1);
  });

  await t("new-line applied (sku absent from pre, present at exactly qty after) is corroborated", async () => {
    const r = await gateOn({ pre: 0, post: 3, otherPre: 1, otherPost: 1, qty: 3, scenario: "ok" });
    assert.deepEqual(failed(r), [], "a brand-new line at the requested quantity is the exact increment");
  });

  await t("exact increment while ANOTHER row also moved is confounded (not corroborated)", async () => {
    const r = await gateOn({ pre: 0, post: 3, otherPre: 1, otherPost: 4, qty: 3, scenario: "ok" });
    assert.ok(failed(r).includes("claim_from_observed_state"), "a concurrent change elsewhere cannot be attributed to this call");
  });

  await t("partial increment (2 landed of 3 requested) is not corroborated as applied", async () => {
    const r = await gateOn({ pre: 0, post: 2, qty: 3, scenario: "ok" });
    assert.ok(failed(r).includes("claim_from_observed_state"), "the cart must show what was asked for, not part of it");
  });

  await t("over-increment (4 landed for 3 requested) is not corroborated as applied", async () => {
    const r = await gateOn({ pre: 0, post: 4, qty: 3, scenario: "ok" });
    assert.ok(failed(r).includes("claim_from_observed_state"), "more than requested is somebody else's change too");
  });

  await t("fractional request 1.5 corroborated only by exactly 1.5 more (1.5 -> 3.0)", async () => {
    const r = await gateOn({ pre: 1.5, post: 3, qty: 1.5, scenario: "ok" });
    assert.deepEqual(failed(r), [], "exact fractional increment passes");
    const short = await gateOn({ pre: 1.5, post: 2.5, qty: 1.5, scenario: "ok" });
    assert.ok(failed(short).includes("claim_from_observed_state"), "1.0 of a requested 1.5 is partial");
  });

  // ---- the pre-read failure seen LIVE on 2026-11-01: Syntax Error => nothing is dispatched
  await t("baseline refused (GRAPHQL_ERRORS, the live Syntax Error): gate fails and spends NO mutation", async () => {
    const r = await gateOn({ pre: 1, post: 1, qty: 0.5, scenario: "baseline_syntax_error" });
    // the refused baseline fails, dispatch acceptance fails with it (nothing reached the
    // backend), and no post-read is asked for. "unknown" is still corroborated: it claims naught.
    assert.deepEqual(failed(r), ["baseline_read", "dispatch_accounting"]);
    assert.match(why(r, "baseline_read"), /GRAPHQL_ERRORS/, "the failure names the code the server answered");
    assert.deepEqual(r.seen, ["mm_get_cart"], "ONLY the baseline read: no write was asked for, so no mutation was spent and none could be retried");
    assert.match(why(r, "dispatch_accounting"), /NO_BASELINE/, "the gate names why nothing was dispatched");
    assert.match(why(r, "dispatch_accounting"), /not attempted and not retried/);
    assert.equal(fact(r, "never_retried_by_gate").gate_asked_for_write, 0, "zero write requests: nothing to retry");
    assert.equal(fact(r, "post_read").skipped, true, "no baseline => no post-read asked");
    assert.equal(fact(r, "claim_from_observed_state").verdict, "unknown", "no observed pair => no claim is made");
  });

  await t("baseline lost (no answer at all): reported as lost, gate fails, no write dispatched", async () => {
    const r = await gateOn({ pre: 1, post: 1, qty: 1, scenario: "baseline_lost" });
    assert.deepEqual(failed(r), ["baseline_read", "dispatch_accounting"]);
    assert.match(why(r, "baseline_read"), /lost/, "a lost answer says lost, not refused");
    assert.deepEqual(r.seen, ["mm_get_cart"], "the lost baseline is the only call: no write spent");
    assert.match(why(r, "dispatch_accounting"), /NO_BASELINE/);
  });

  // ---- pre-dispatch refusal: failed acceptance naming the code, NOT a duplicate-flag claim
  await t("pre-dispatch refusal (OUT_OF_STOCK, cart unchanged): failed acceptance naming the code, no duplicate-flag assertion", async () => {
    const r = await gateOn({ pre: 4, post: 4, qty: 1, scenario: "refused_no_dispatch" });
    // the refusal IS corroborated (cart unchanged => "rejected" holds), yet acceptance FAILED:
    // zero mutations reached the backend, so this run proves no dispatch
    assert.deepEqual(failed(r), ["dispatch_accounting"]);
    assert.match(why(r, "dispatch_accounting"), /pre-dispatch refusal \(OUT_OF_STOCK\)/, "the gate names the pre-dispatch code");
    assert.match(why(r, "dispatch_accounting"), /nothing reached the backend/);
    assert.equal(fact(r, "claim_from_observed_state").verdict, "rejected", "the refusal claim is corroborated by an unchanged cart");
    assert.deepEqual(r.seen, CALLS, "one write asked, refused, never re-issued");
  });

  await t("refusal that grew the cart is not corroborated either", async () => {
    const moved = await gateOn({ pre: 4, post: 6, qty: 1, scenario: "refused_no_dispatch" });
    assert.deepEqual(failed(moved), ["dispatch_accounting", "claim_from_observed_state"]);
  });

  await t("guard replay (duplicate_intent true, 0 dispatched): reported as a replay, not as a fresh refusal", async () => {
    const r = await gateOn({ pre: 4, post: 4, qty: 1, scenario: "dup_replay" });
    assert.deepEqual(failed(r), ["dispatch_accounting"], "a replay dispatched nothing: acceptance failed, and this is a replay, not a first refusal");
    assert.match(why(r, "dispatch_accounting"), /INTENT_IN_FLIGHT/);
    assert.deepEqual(r.seen, CALLS, "one write asked: answered from the guard, never re-issued");
  });

  await t("answer lost (child dies during the write): reported, never re-issued", async () => {
    const r = await gateOn({ pre: 1, post: 2, qty: 1, scenario: "child_dies" });
    assert.deepEqual(r.seen, ["mm_get_cart", "mm_add_to_cart"], "ONE add ever, no retry");
    assert.deepEqual(failed(r), ["dispatch_accounting", "post_read"], "the lost dispatch is reported, not hidden");
    assert.match(why(r, "dispatch_accounting"), /answer was lost/, "the count is not invented");
    assert.match(why(r, "dispatch_accounting"), /did not retry/);
    assert.equal(fact(r, "claim_from_observed_state").verdict, "unknown", "no answer means no claim");
    assert.equal(fact(r, "never_retried_by_gate").gate_asked_for_write, 1);
  });

  await t("post-read lost after a dispatched write: gate fails, the write is not re-issued", async () => {
    const r = await gateOn({ pre: 1, post: 2, qty: 1, scenario: "post_lost" });
    assert.deepEqual(failed(r), ["post_read", "claim_from_observed_state"], "dispatch happened; the outcome could not be observed");
    assert.equal(fact(r, "dispatch_accounting").mutation_count, 1, "the write itself was dispatched and counted");
    assert.deepEqual(r.seen, ["mm_get_cart", "mm_add_to_cart", "mm_get_cart"], "one write, one post-read, no second write");
  });

  await t("invented vocabulary is refused: applied_with_warnings is not a verdict", async () => {
    const r = await gateOn({ pre: 1, post: 2, qty: 1, scenario: "ok", verdict: "applied_with_warnings" });
    assert.ok(failed(r).includes("claim_from_observed_state"), "no invented verdict vocabulary");
  });

  await t("a credential-bearing answer is caught by no_secret_leak", async () => {
    const r = await gateOn({ pre: 1, post: 2, qty: 1, scenario: "leak" });
    assert.deepEqual(failed(r), ["no_secret_leak"], "Bearer material in a report is a leak");
  });

  await t("claimSupported is exact for the three-word vocabulary and refuses anything else", () => {
    assert.equal(claimSupported("applied", { kind: "exact increment" }), true);
    assert.equal(claimSupported("applied", { kind: "unchanged" }), false, "the exact bug: nothing happened");
    assert.equal(claimSupported("applied", { kind: "partial (less than requested)" }), false);
    assert.equal(claimSupported("applied", { kind: "over_increment (more than requested)" }), false);
    assert.equal(claimSupported("applied", { kind: "exact increment but other rows moved (confounded)" }), false);
    assert.equal(claimSupported("rejected", { kind: "unchanged" }), true);
    assert.equal(claimSupported("rejected", { kind: "exact increment" }), false);
    assert.equal(claimSupported("unknown", { kind: "decreased" }), true, "unknown claims nothing");
    assert.equal(claimSupported("applied_with_warnings", { kind: "exact increment" }), false, "no invented vocabulary");
    assert.equal(claimSupported(undefined, { kind: "unchanged" }), false);
  });

  await t("addObserved handles float noise without inventing a change", () => {
    const cart = (q) => ({ items: [{ uid: "u1", sku: "GATE_SKU", quantity: q }] });
    assert.equal(addObserved({ pre: cart(0.1 + 0.2), post: cart(0.30000000001), sku: "GATE_SKU", qty: 0 }).kind, "unchanged", "float noise under the epsilon is not a change");
    assert.equal(addObserved({ pre: cart(2.25), post: cart(3.75), sku: "GATE_SKU", qty: 1.5 }).kind, "exact increment");
    assert.equal(addObserved({ pre: cart(1), post: cart(0.5), sku: "GATE_SKU", qty: 1 }).kind, "decreased");
    assert.equal(addObserved({ pre: null, post: cart(1), sku: "GATE_SKU", qty: 1 }).corroborated, false, "an unreadable pair corroborates nothing");
  });

  await t("gateBlock names exactly one missing approval and returns null when all four are present", () => {
    assert.match(gateBlock({}), /MM_MCP_LIVE!=1/);
    assert.match(gateBlock({ MM_MCP_LIVE: "1" }), /MM_CART_WRITE_APPROVED/);
    assert.match(gateBlock({ ...APPROVED }), /MM_LIVE_SKU/);
    assert.match(gateBlock({ ...APPROVED, MM_LIVE_SKU: "X", MM_LIVE_QTY: "-2" }), /MM_LIVE_QTY/);
    assert.equal(gateBlock({ ...APPROVED, MM_LIVE_SKU: "X", MM_LIVE_QTY: "1" }), null);
  });

  console.log(`${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
