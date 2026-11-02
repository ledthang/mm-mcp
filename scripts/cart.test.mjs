#!/usr/bin/env node
// mm-mcp cart WRITE adapter tests: injected fetch + temp auth fixture, node:assert only,
// serial. All data FAKE. Every write follows pre-read -> ONE mutation -> post-read; the
// fetch here answers by request kind (snapshot vs which mutation) so each scenario is fully
// controlled offline. Nothing touches the network.
//
// Covers:
//  * args strictness per tool: unknown props / cart id refused, zero network
//  * confirm gate: missing/false => nothing dispatched (CONFIRM_REQUIRED / NOT_CONFIRMED)
//  * credential problem => REQUIRES_LOGIN, zero mutation requests
//  * add: pre(empty) -> mutation ok -> post(one line) => applied, new_line layout
//  * add duplicate intent guard: second identical call answered from guard, ZERO requests
//  * update: absolute interpretation observed => applied; delta observed => applied; neither => unknown
//  * update uid not in cart => NOT_IN_CART, zero mutation
//  * remove: uid present pre, absent post => applied; still present => unknown
//  * mutation transport error (HTTP 500) => unknown, dispatched 1, never retried
//  * per-line user_errors => rejected
//  * secret redaction: FAKE token never in any output
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCart, ADD_DOC, UPDATE_DOC, REMOVE_DOC, CART_SNAPSHOT_QUERY, TOOLS } from "../src/cart.mjs";

const FAKE_AUTH = "Bearer eyFAKEtoken-not-real-9x";
const STORE = "b2c_70010_vi";
const BASE = mkdtempSync(path.join(os.tmpdir(), "mmcart-"));
process.on("exit", () => rmSync(BASE, { recursive: true, force: true }));
const isObj = (v) => v !== null && typeof v === "object";
const text = (env) => env.content[0].text;
const payload = (env) => JSON.parse(text(env));

function credEnv() {
  const root = mkdtempSync(path.join(BASE, "cred-"));
  mkdirSync(path.join(root, "mm-mcp"));
  chmodSync(path.join(root, "mm-mcp"), 0o700);
  const file = path.join(root, "mm-mcp", "auth.json");
  writeFileSync(file, JSON.stringify({ authorization: FAKE_AUTH, store: STORE }));
  chmodSync(file, 0o600);
  return { XDG_DATA_HOME: root, MM_AUTH_FILE: file };
}

// cart snapshot payload in the shape CART_SNAPSHOT_QUERY projects.
const snap = ({ id = "cart1", items = [], total_quantity = items.reduce((s, l) => s + l.quantity, 0), grand_total = 0, currency = "VND" } = {}) => ({
  data: { customerCart: {
    id, total_quantity,
    items: items.map((it) => ({
      uid: it.uid, quantity: it.quantity,
      product: { sku: it.sku, name: it.name ?? it.sku },
      prices: { price: { value: it.price, currency }, row_total: { value: it.row_total ?? it.price * it.quantity, currency } },
    })),
    prices: { grand_total: { value: grand_total, currency } },
  } },
});

// A fetch that answers by request kind. `plan` is a map: { snapshot:[...], add:[...], update:[...], remove:[...] },
// each an ordered list of responses (or {status} / Error). Consumption is per-kind, independent.
function mk(plan, env = credEnv()) {
  const calls = [];
  const used = { snapshot: 0, add: 0, update: 0, remove: 0 };
  const fetchImpl = async (url, init) => {
    const body = String(init.body ?? "");
    let kind;
    if (body.includes("addProductsToCart")) kind = "add";
    else if (body.includes("updateCartItems")) kind = "update";
    else if (body.includes("removeItemFromCart")) kind = "remove";
    else if (body.includes("customerCart")) kind = "snapshot";
    else kind = "other";
    const list = plan[kind] || [];
    const idx = used[kind];
    used[kind] += 1;
    // NO clamping. A request past the end of its plan is recorded as `beyond` and answered
    // with a 599 the assertions can see: a Math.min clamp repeated the last fixture, which
    // made an unexpected EXTRA dispatch (a second add, a surprise third read) look exactly
    // like the intended answer. Valid fixtures are untouched — only overflow is marked.
    const beyond = idx >= list.length;
    const spec = beyond ? { overflow: `${kind}#${idx + 1}` } : list[idx];
    calls.push({ kind, url: String(url), init, seq: used[kind], beyond });
    if (spec instanceof Error) throw spec;
    // a plan entry is: an Error (transport failure) | {status[,body]} (HTTP failure) |
    // {wait, answer} (held until the test opens the barrier, then `answer`) | the answer itself
    let resolved = spec;
    if (isObj(resolved) && resolved.wait) { await resolved.wait; resolved = resolved.answer; }
    if (resolved instanceof Promise) resolved = await resolved;
    if (resolved instanceof Error) throw resolved;
    if (isObj(resolved) && "status" in resolved && !("data" in resolved)) {
      return new Response(JSON.stringify(resolved.body ?? {}), { status: resolved.status });
    }
    if (isObj(resolved) && resolved.overflow) {
      return new Response(JSON.stringify({ errors: [{ message: `beyond_plan ${resolved.overflow}` }] }), { status: 599 });
    }
    // GraphQL answers are always envelope-shaped ({data:...} on success). `snap()` already
    // emits the envelope; mutation plans here are written as the bare payload and are
    // wrapped, so every fake answer has the real shape instead of a convenient one.
    return new Response(JSON.stringify(isObj(resolved) && "data" in resolved ? resolved : { data: resolved ?? {} }), { status: 200 });
  };
  const cart = createCart({ fetchImpl, env });
  const kindCounts = () => ({ ...used });
  const beyondCount = () => calls.filter((c) => c.beyond).length;
  return { cart, calls, kindCounts, beyondCount, run: (name, args = {}) => cart.callTool(name, args) };
}

// Bounded wait on a condition: polls every POLL_MS up to a deadline and returns as soon as
// the condition holds. Only ever a couple of seconds here (injected, bounded) — a stuck
// scenario FAILS on the deadline, it never hangs, and no test waits out a real 25/80 s.
const POLL_MS = 5;
async function until(cond, deadlineMs = 3000) {
  const stop = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= stop) return false;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// a barrier the test controls: the fake holds on `promise`, the test opens it when ready
function defer() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open: () => open(true) };
}

const L1 = { uid: "u1", sku: "SKU_A", name: "Item A", quantity: 2, price: 10000 };

let checks = 0, failures = 0;
async function t(name, fn) {
  checks += 1;
  try { await fn(); console.error("PASS " + name); }
  catch (e) { failures += 1; console.error("FAIL " + name + " :: " + (e && e.message)); }
}

async function main() {
  await t("tools: exactly three write tools, additionalProperties false", () => {
    assert.deepEqual(TOOLS.map((x) => x.name), ["mm_add_to_cart", "mm_update_cart_item", "mm_remove_cart_item"]);
    assert.ok(TOOLS.every((x) => x.inputSchema.additionalProperties === false));
  });

  await t("add missing confirm: CONFIRM_REQUIRED, zero network", async () => {
    const { run, calls } = mk({});
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3 });
    assert.equal(r.isError, true);
    assert.match(text(r), /CONFIRM_REQUIRED/);
    assert.equal(calls.length, 0);
  });

  await t("confirm false: NOT_CONFIRMED, zero network", async () => {
    const { run, calls } = mk({});
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: false });
    assert.equal(r.isError, true);
    assert.match(text(r), /NOT_CONFIRMED/);
    assert.equal(calls.length, 0);
  });

  await t("cart_id argument refused, zero network", async () => {
    const { run, calls } = mk({});
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true, cart_id: "x" });
    assert.equal(r.isError, true);
    assert.match(text(r), /no cart id is accepted/);
    assert.equal(calls.length, 0);
  });

  await t("unknown argument refused, zero network", async () => {
    const { run, calls } = mk({});
    const r = await run("mm_update_cart_item", { item_uid: "u1", quantity: 2, confirm: true, foo: 1 });
    assert.equal(r.isError, true);
    assert.match(text(r), /unknown argument\(s\): foo/);
    assert.equal(calls.length, 0);
  });

  await t("quantity 0 refused (implicit remove), zero network", async () => {
    const { run, calls } = mk({});
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 0, confirm: true });
    assert.equal(r.isError, true);
    assert.match(text(r), /quantity 0 is not an implicit remove/);
    assert.equal(calls.length, 0);
  });

  await t("credential missing dir: REQUIRES_LOGIN, zero request", async () => {
    const { run, calls } = mk({ snapshot: [], add: [] }, { XDG_DATA_HOME: path.join(BASE, "nope"), MM_AUTH_FILE: path.join(BASE, "nope", "mm-mcp", "auth.json") });
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true });
    assert.equal(r.isError, true);
    assert.match(text(r), /REQUIRES_LOGIN/);
    assert.equal(calls.length, 0);
  });

  await t("add happy path: pre empty -> mutation ok -> post one line => applied, new_line", async () => {
    const { run, calls, kindCounts } = mk({
      snapshot: [snap({ items: [], total_quantity: 0, grand_total: 0 }), snap({ items: [{ ...L1, quantity: 3 }], grand_total: 30000 })],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [] } }],
    });
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true });
    const p = payload(r);
    assert.ok(!r.isError, "success envelope: isError omitted (set only on failure, repo convention)");
    assert.equal(p.verdict, "applied");
    assert.equal(p.mutation_count, 1);
    assert.equal(p.layout, "new_line (sku absent from pre)");
    assert.equal(p.cart_change_detected, true);
    // order: snapshot, mutation, snapshot
    assert.deepEqual(calls.map((c) => c.kind), ["snapshot", "add", "snapshot"]);
    assert.equal(kindCounts().add, 1, "exactly one mutation dispatched");
  });

  await t("add: mutation user_errors => rejected", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [] }), snap({ items: [] })],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 0, items: [], prices: { grand_total: { currency: "VND", value: 0 } } }, user_errors: [{ code: "OUT_OF_STOCK", message: "hết hàng" }] } }],
    });
    const p = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(p.verdict, "rejected");
    assert.ok(p.errors.some((e) => e.code === "OUT_OF_STOCK"));
  });

  await t("add: HTTP 500 on mutation => unknown, dispatched 1, never retried", async () => {
    const { kindCounts, run } = mk({
      snapshot: [snap({ items: [] }), snap({ items: [{ ...L1, quantity: 3 }] })],
      add: [{ status: 500 }],
    });
    const p = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(p.verdict, "unknown");
    assert.equal(p.mutation_count, 1);
    assert.equal(kindCounts().add, 1, "no retry on 500");
  });

  await t("duplicate intent guard: second identical add answered from guard, ZERO new requests", async () => {
    const { run, kindCounts } = mk({
      snapshot: [snap({ items: [] }), snap({ items: [{ ...L1, quantity: 3 }] })],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [] } }],
    });
    const first = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(first.verdict, "applied");
    const c1 = kindCounts();
    const second = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(second.duplicate_intent, true);
    assert.equal(second.mutation_count, 0);
    const c2 = kindCounts();
    assert.deepEqual(c2, c1, "guard hit made zero new requests");
  });

  // ---- concurrency: the guard must be claimed BEFORE the pre-read await, otherwise two
  // identical calls that arrive together both dispatch and the cart gets the item twice.
  // The barrier below is injected, not slept: the pre-read stays held until this test opens
  // it, so "both were in flight at once" is a fact the test controls.
  await t("concurrent identical add: EXACTLY ONE mutation forward, the loser dispatches nothing and does not wait", async () => {
    const held = defer();
    const { run, kindCounts, beyondCount } = mk({
      snapshot: [{ wait: held.promise, answer: snap({ items: [] }) }, snap({ items: [{ ...L1, quantity: 3 }] })],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [] } }],
    });
    const first = run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }); // pre-read now held
    assert.ok(await until(() => kindCounts().snapshot === 1), "first call's pre-read is in flight");
    const second = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(second.code, "INTENT_IN_FLIGHT", "the second identical call sees the live claim");
    assert.equal(second.mutation_count, 0, "it dispatched nothing");
    assert.equal(second.duplicate_intent, true);
    assert.deepEqual(kindCounts(), { snapshot: 1, add: 0, update: 0, remove: 0 }, "the loser made no request at all");
    held.open(); // only now may the first proceed
    const firstP = payload(await first);
    assert.equal(firstP.verdict, "applied");
    assert.deepEqual(kindCounts(), { snapshot: 2, add: 1, update: 0, remove: 0 }, "exactly one addProductsToCart ever");
    assert.equal(beyondCount(), 0, "no request beyond the plan");
  });

  // ---- the guard is bounded, and when every slot is in flight it FAILS CLOSED: it neither
  // dispatches (which would be unguarded) nor grows the map. Answers here are PHASE-based
  // (before the barrier opens = a pre-read, after = a post-read): with 64 calls in flight the
  // arrival order is not the call order, so an ordered answer list would hand a post-state to
  // a pre-read and invent a false "no change" for honest calls.
  await t("guard bound: 64 in-flight intents fill it, the 65th fails closed with zero requests", async () => {
    const held = defer();
    let opened = false;
    const preCart = snap({ items: Array.from({ length: 64 }, (_, i) => ({ uid: `u${i}`, sku: `SKU_${i}`, name: `P${i}`, quantity: 2, price: 1000 })), grand_total: 128000 });
    const postCart = snap({ items: Array.from({ length: 64 }, (_, i) => ({ uid: `u${i}`, sku: `SKU_${i}`, name: `P${i}`, quantity: 3, price: 1000 })), grand_total: 192000 });
    const counts = { snapshot: 0, update: 0, beyond: 0 };
    const fetchImpl = async (url, init) => {
      const body = String(init.body ?? "");
      if (body.includes("customerCart")) {
        counts.snapshot += 1;
        // the answer is decided AT ARRIVAL (before the wait): whoever is waiting when the
        // barrier opens must still be shown the pre-state, not a post-state it never read
        const phase = opened ? postCart : preCart;
        await held.promise; // every read is held: no call can finish before the test says go
        return new Response(JSON.stringify(phase), { status: 200 });
      }
      if (body.includes("updateCartItems")) {
        if (!opened) { counts.beyond += 1; return new Response(JSON.stringify({ errors: [{ message: "update before the barrier opened" }] }), { status: 599 }); }
        counts.update += 1;
        return new Response(JSON.stringify({ data: { updateCartItems: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } } } } }), { status: 200 });
      }
      counts.beyond += 1;
      return new Response(JSON.stringify({ errors: [{ message: "unexpected request" }] }), { status: 599 });
    };
    const cart = createCart({ fetchImpl, env: credEnv() });
    const all = Array.from({ length: 64 }, (_, i) => cart.callTool("mm_update_cart_item", { item_uid: `u${i}`, quantity: 3, confirm: true }));
    assert.ok(await until(() => counts.snapshot === 64), "64 pre-reads in flight");
    const extra = JSON.parse((await cart.callTool("mm_update_cart_item", { item_uid: "u99", quantity: 3, confirm: true })).content[0].text);
    assert.equal(extra.code, "GUARD_FULL", "no slot free: nothing dispatched");
    assert.equal(extra.mutation_count, 0);
    assert.deepEqual({ ...counts }, { snapshot: 64, update: 0, beyond: 0 }, "the 65th made no request");
    held.open(); opened = true;
    const rs = (await Promise.all(all)).map((r) => JSON.parse(r.content[0].text));
    assert.equal(rs.filter((p) => p.verdict === "applied").length, 64, "all 64 intents applied: " + JSON.stringify(rs.reduce((m, p) => { const k = String(p.code ?? p.verdict); m[k] = (m[k] ?? 0) + 1; return m; }, {})));
    assert.deepEqual({ ...counts }, { snapshot: 128, update: 64, beyond: 0 }, "no duplicate dispatch, no extra read");
  });

  // ---- identity: a report earned under credential A is never handed back as credential B.
  // Same store code, same intent, rotated token => the guard must not answer for it.
  await t("credential rotation: account B is never answered from account A's report", async () => {
    const root = mkdtempSync(path.join(BASE, "rot-"));
    mkdirSync(path.join(root, "mm-mcp"));
    chmodSync(path.join(root, "mm-mcp"), 0o700);
    const file = path.join(root, "mm-mcp", "auth.json"); // ONE path, two successive credentials
    const write = (tok) => { writeFileSync(file, JSON.stringify({ authorization: `Bearer ${tok}`, store: STORE })); chmodSync(file, 0o600); };
    write("FAKEv1notreal");
    const { run, calls, kindCounts, beyondCount } = mk({
      snapshot: [snap({ items: [] }), snap({ items: [{ ...L1, quantity: 3 }] }), snap({ items: [] }), snap({ items: [{ ...L1, quantity: 3 }] })],
      add: [
        { addProductsToCart: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [] } },
        { addProductsToCart: { cart: { id: "cart1", total_quantity: 6, items: [], prices: { grand_total: { currency: "VND", value: 60000 } } }, user_errors: [] } },
      ],
    }, { XDG_DATA_HOME: root, MM_AUTH_FILE: file });
    const a = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(a.verdict, "applied");
    const c1 = kindCounts();
    const sameCred = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.equal(sameCred.duplicate_intent, true, "same credential, same intent: answered from the guard");
    assert.deepEqual(kindCounts(), c1, "guard hit made zero requests");
    write("FAKEv2rotated"); // operator rotates the credential between calls
    const b = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true }));
    assert.ok(!b.duplicate_intent, "a rotated credential is a DIFFERENT owner: not a duplicate of A's dispatch");
    assert.equal(b.verdict, "applied");
    assert.deepEqual(kindCounts(), { snapshot: 4, add: 2, update: 0, remove: 0 }, "B dispatched its own mutation");
    assert.equal(beyondCount(), 0, "no request beyond the plan");
    const leaked = calls.map((c) => c.init.headers.Authorization).join(" ");
    assert.ok(leaked.includes("FAKEv1notreal") && leaked.includes("FAKEv2rotated"), "headers do carry the credential...");
    assert.ok(!/FAKEv1notreal|FAKEv2rotated|Bearer /.test(JSON.stringify([a, sameCred, b])), "...but no report echoes it");
  });

  await t("update: uid not in pre-cart => NOT_IN_CART, zero mutation", async () => {
    const { kindCounts, run } = mk({ snapshot: [snap({ items: [{ ...L1 }] })] });
    const p = payload(await run("mm_update_cart_item", { item_uid: "zzz", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "rejected");
    assert.match(text({ content: [{ text: JSON.stringify(p) }] }), /NOT_IN_CART/);
    assert.equal(kindCounts().update, 0);
  });

  await t("update absolute interpretation: post qty == requested => applied (matches_absolute)", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [{ ...L1, quantity: 2 }] }), snap({ items: [{ ...L1, quantity: 5 }] })],
      update: [{ updateCartItems: { cart: { id: "cart1", total_quantity: 5, items: [], prices: { grand_total: { currency: "VND", value: 50000 } } } } }],
    });
    const p = payload(await run("mm_update_cart_item", { item_uid: "u1", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "applied");
    assert.equal(p.matches_absolute, true);
  });

  await t("update delta interpretation: post qty == pre+requested => applied (matches_delta)", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [{ ...L1, quantity: 2 }] }), snap({ items: [{ ...L1, quantity: 7 }] })],
      update: [{ updateCartItems: { cart: { id: "cart1", total_quantity: 7, items: [], prices: { grand_total: { currency: "VND", value: 70000 } } } } }],
    });
    const p = payload(await run("mm_update_cart_item", { item_uid: "u1", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "applied");
    assert.equal(p.matches_delta, true);
    assert.equal(p.matches_absolute, false);
  });

  await t("update neither abs nor delta => unknown", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [{ ...L1, quantity: 2 }] }), snap({ items: [{ ...L1, quantity: 99 }] })],
      update: [{ updateCartItems: { cart: { id: "cart1", total_quantity: 99, items: [], prices: { grand_total: { currency: "VND", value: 990000 } } } } }],
    });
    const p = payload(await run("mm_update_cart_item", { item_uid: "u1", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "unknown");
  });

  await t("remove: present pre, absent post => applied", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [{ ...L1 }] }), snap({ items: [], total_quantity: 0 })],
      remove: [{ removeItemFromCart: { cart: { id: "cart1", total_quantity: 0, items: [], prices: { grand_total: { currency: "VND", value: 0 } } } } }],
    });
    const p = payload(await run("mm_remove_cart_item", { item_uid: "u1", confirm: true }));
    assert.equal(p.verdict, "applied");
    assert.equal(p.uid_present_post, false);
  });

  await t("remove: uid still present post => unknown (cannot attribute)", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [{ ...L1 }] }), snap({ items: [{ ...L1 }] })],
      remove: [{ removeItemFromCart: { cart: { id: "cart1", total_quantity: 2, items: [], prices: { grand_total: { currency: "VND", value: 20000 } } } } }],
    });
    const p = payload(await run("mm_remove_cart_item", { item_uid: "u1", confirm: true }));
    assert.equal(p.verdict, "unknown");
  });

  // ---- errors + a changed cart cannot prove refusal: a partial application is a realistic
  // answer ("3 of 5 landed, the rest out of stock"). Only errors WITH an unchanged cart is a
  // corroborated rejection; everything else is unknown. One mutation, never retried.
  await t("add: errors AND a changed cart (partial landing) => UNKNOWN, one mutation, no retry", async () => {
    const { run, kindCounts, calls } = mk({
      snapshot: [snap({ items: [], total_quantity: 0, grand_total: 0 }), snap({ items: [{ ...L1, quantity: 3 }], grand_total: 30000 })],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [{ code: "OUT_OF_STOCK", message: "chỉ còn 3" }] } }],
    });
    const p = payload(await run("mm_add_to_cart", { sku: "SKU_A", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "unknown", "3 landed with a complaint: that is not a proven refusal");
    assert.equal(p.cart_change_detected, true, "the cart did move — the only question is by whom/how much");
    assert.ok(p.errors.some((e) => e.code === "OUT_OF_STOCK"), "the backend error is still surfaced verbatim");
    assert.equal(p.mutation_count, 1);
    assert.equal(kindCounts().add, 1, "errors never cause a retry from this side");
    assert.deepEqual(calls.map((c) => c.kind), ["snapshot", "add", "snapshot"], "pre -> ONE mutation -> post");
  });

  await t("update: errors but the observed quantity matches the request => UNKNOWN (not applied)", async () => {
    const { run, kindCounts } = mk({
      snapshot: [snap({ items: [{ ...L1, quantity: 2 }] }), snap({ items: [{ ...L1, quantity: 5 }] })],
      update: [{ updateCartItems: { cart: { id: "cart1", total_quantity: 5, items: [{ uid: "u1", quantity: 5, errors: [{ code: "PRICE_CHANGED", message: "giá đã đổi" }] }], prices: { grand_total: { currency: "VND", value: 50000 } } } } }],
    });
    const p = payload(await run("mm_update_cart_item", { item_uid: "u1", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "unknown", "the cart shows 5 but the backend complained: it may be somebody else's 5");
    assert.equal(p.matches_absolute, true, "the shape still reports what was observed");
    assert.ok(p.errors.some((e) => e.code === "PRICE_CHANGED"));
    assert.equal(kindCounts().update, 1, "no retry");
  });

  await t("update: errors AND unchanged cart => rejected (corroborated refusal)", async () => {
    const { run, kindCounts } = mk({
      snapshot: [snap({ items: [{ ...L1, quantity: 2 }] }), snap({ items: [{ ...L1, quantity: 2 }] })],
      update: [{ updateCartItems: { cart: { id: "cart1", total_quantity: 2, items: [{ uid: "u1", quantity: 2, errors: [{ code: "MIN_QTY", message: "tối thiểu 3" }] }], prices: { grand_total: { currency: "VND", value: 20000 } } } } }],
    });
    const p = payload(await run("mm_update_cart_item", { item_uid: "u1", quantity: 5, confirm: true }));
    assert.equal(p.verdict, "rejected");
    assert.equal(p.cart_change_detected, false, "nothing moved: the refusal is corroborated");
    assert.equal(kindCounts().update, 1);
  });

  await t("remove: errors AND the line is gone => UNKNOWN (something removed it, maybe not us)", async () => {
    const { run, kindCounts } = mk({
      snapshot: [snap({ items: [{ ...L1 }] }), snap({ items: [], total_quantity: 0 })],
      remove: [{ removeItemFromCart: { cart: { id: "cart1", total_quantity: 0, items: [{ uid: "u1", quantity: 1, errors: [{ code: "ALREADY_REMOVED", message: "đã xoá" }] }], prices: { grand_total: { currency: "VND", value: 0 } } } } }],
    });
    const p = payload(await run("mm_remove_cart_item", { item_uid: "u1", confirm: true }));
    assert.equal(p.verdict, "unknown", "uid_present_post false with an error: cannot tell whether this call did it");
    assert.equal(p.uid_present_post, false);
    assert.equal(kindCounts().remove, 1);
  });

  await t("secret redaction: FAKE token appears in no output", async () => {
    const { run } = mk({
      snapshot: [snap({ items: [] }), snap({ items: [{ ...L1, quantity: 3 }] })],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 3, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [] } }],
    });
    const r = await run("mm_add_to_cart", { sku: "SKU_A", quantity: 3, confirm: true });
    assert.ok(!text(r).includes(FAKE_AUTH));
    assert.ok(!/eyFAKE/.test(text(r)));
  });

  await t("cart id + snapshot query never embed a caller id", () => {
    assert.ok(!/\bcart_id\s*:/.test(CART_SNAPSHOT_QUERY));
    assert.ok(ADD_DOC.includes("$cartId"));
  });

  await t("wire shape: cart id resolved internally, fractional quantities passed through unchanged", async () => {
    const L9 = (q) => ({ uid: "u9", sku: "RICE5", name: "Gạo ST 25", quantity: q, price: 20000 });
    const { run, calls } = mk({
      snapshot: [
        snap({ items: [] }), snap({ items: [L9(1.5)], grand_total: 30000 }), // add flow
        snap({ items: [L9(1.5)], grand_total: 30000 }), snap({ items: [L9(2.25)], grand_total: 45000 }), // update flow
        snap({ items: [L9(2.25)], grand_total: 45000 }), snap({ items: [], grand_total: 0 }), // remove flow
      ],
      add: [{ addProductsToCart: { cart: { id: "cart1", total_quantity: 1.5, items: [], prices: { grand_total: { currency: "VND", value: 30000 } } }, user_errors: [] } }],
      update: [{ updateCartItems: { cart: { id: "cart1", total_quantity: 2.25, items: [], prices: { grand_total: { currency: "VND", value: 45000 } } } } }],
      remove: [{ removeItemFromCart: { cart: { id: "cart1", total_quantity: 0, items: [], prices: { grand_total: { currency: "VND", value: 0 } } } } }],
    });
    const a = payload(await run("mm_add_to_cart", { sku: "RICE5", quantity: 1.5, confirm: true }));
    const b = payload(await run("mm_update_cart_item", { item_uid: "u9", quantity: 2.25, confirm: true }));
    const c = payload(await run("mm_remove_cart_item", { item_uid: "u9", confirm: true }));
    assert.deepEqual([a.verdict, b.verdict, c.verdict], ["applied", "applied", "applied"]);
    assert.deepEqual([a.quantity_observed, b.quantity_observed, c.uid_present_post], [1.5, 2.25, false]);
    const muts = calls.filter((x) => x.kind !== "snapshot");
    assert.deepEqual(muts.map((m) => m.kind), ["add", "update", "remove"]);
    assert.ok(muts.every((m) => m.init.method === "POST"), "a mutation is never sent as GET");
    assert.ok(calls.every((x) => x.url === "https://online.mmvietnam.com/graphql"), "single origin");
    assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["Authorization", "content-type", "store"], "exactly the auth+store header pair");
    const vars = muts.map((m) => JSON.parse(m.init.body).variables);
    assert.deepEqual(vars[0], { cartId: "cart1", cartItem: { sku: "RICE5", quantity: 1.5 } }, "add: {sku,quantity}, fraction exact, cart id from the resolved snapshot");
    assert.deepEqual(vars[1], { cartId: "cart1", itemId: "u9", quantity: 2.25 }, "update: fraction exact");
    assert.deepEqual(vars[2], { cartId: "cart1", itemId: "u9" }, "remove: uid only, no quantity");
    assert.ok(JSON.stringify(vars[1]).includes("quantity\":2.25"), "2.25 never rounded or truncated");
    const bodies = muts.map((m) => m.init.body).join("");
    assert.ok(!/cart_item_id/.test(bodies), "line addressed by cart_item_uid, never cart_item_id");
    assert.ok(![a, b, c].map((x) => JSON.stringify(x)).join("").includes("cart1"), "the resolved cart id is never emitted in a report");
  });

  // ---- STRUCTURAL: the shipped documents must be well-formed braces. Offline proof of the
  // class that cost the first live attempt (2026-11-01): CART_SNAPSHOT_QUERY was missing one
  // closing brace, so EVERY pre-read answered HTTP 400 "Syntax Error: Expected Name, found
  // <EOF>" and no mutation was ever dispatched. A fake answers whatever it is told, so no
  // amount of fake-based testing would have caught it — this check is cheap and catches the
  // class. It checks BRACES only: balanced braces do not prove GraphQL validity (the real
  // parser is the authority; scripts/cart-parse-proof.mjs is the opt-in proof of that).
  await t("shipped GraphQL documents: braces balanced at every depth, one root operation", () => {
    const shape = (label, q) => {
      let depth = 0, min = 0, inStr = false, esc = false;
      for (const ch of q) {
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; } // no block strings ("\"\"\") in any doc here
        if (ch === "{") depth += 1;
        else if (ch === "}") { depth -= 1; if (depth < min) min = depth; }
      }
      assert.equal(inStr, false, `${label}: an unterminated string literal`);
      assert.equal(depth, 0, `${label}: unbalanced braces (final depth ${depth}) — the exact defect that failed the live pre-read`);
      assert.equal(min, 0, `${label}: a } closes nothing at depth ${min}`);
      assert.equal((q.match(/^\s*(query|mutation)\s/gm) || []).length, 1, `${label}: exactly one root operation`);
      assert.ok(!/\s\{\s*\}/.test(q), `${label}: no empty selection set`);
      return { balanced: true, bytes: q.length };
    };
    const seen = [
      shape("CART_SNAPSHOT_QUERY", CART_SNAPSHOT_QUERY),
      shape("ADD_DOC", ADD_DOC),
      shape("UPDATE_DOC", UPDATE_DOC),
      shape("REMOVE_DOC", REMOVE_DOC),
    ];
    assert.ok(seen.every((s) => s.balanced));
    // the live failure, reproduced byte-level: the snapshot doc minus its last brace is the
    // shape upstream called "Expected Name, found <EOF>"
    const broken = CART_SNAPSHOT_QUERY.slice(0, -1);
    assert.notEqual(broken.split("").reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0), 0, "one brace removed leaves depth 1 open");
  });

  console.error("\n" + `${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
