#!/usr/bin/env node
// Focused tests for the account-live gate harness (scripts/account-live.mjs):
// FAKE children only — no real endpoint, no credential, no MCP server started here.
// Deterministic; every wait is bounded (CALL_TIMEOUT / CLOSE_GRACE upper bounds).
// Importing account-live.mjs launches nothing (main() runs only when the file itself
// is invoked) and creates no temp state; spawnGate is the exported harness.
import assert from "node:assert/strict";
import { spawnGate } from "./account-live.mjs";

let checks = 0;
let failures = 0;
async function t(name, fn) {
  checks += 1;
  try {
    await fn();
    console.error("PASS " + name);
  } catch (e) {
    failures += 1;
    console.error("FAIL " + name + " :: " + (e && e.message));
  }
}

// well-behaved fake MCP child: one valid envelope per request line, exits on stdin end
const RESPONDER = `
const rl = require("readline").createInterface({ input: process.stdin });
function ok(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
rl.on("line", (l) => {
  let r; try { r = JSON.parse(l); } catch (e) { return; }
  if (r.id === undefined || r.jsonrpc !== "2.0") return;
  if (r.method === "initialize") ok(r.id, { protocolVersion: "2024-11-05", serverInfo: { name: "fake-mcp" }, capabilities: {} });
  else if (r.method === "ping") ok(r.id, {});
  else ok(r.id, { ok: true });
});
rl.on("close", () => process.exit(0));
`;
// answers each request TWICE in one write (duplicate frame must be counted, not silent)
const DUPLICATOR = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  let r; try { r = JSON.parse(l); } catch (e) { return; }
  if (r.id === undefined || r.jsonrpc !== "2.0") return;
  const one = JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} });
  process.stdout.write(one + "\\n" + one + "\\n");
});
rl.on("close", () => process.exit(0));
`;
// answers with one oversized line (over the 2 MiB cap) then holds the event loop open:
// the gate must answer LOCAL_LIMIT and SIGKILL it (close bounded by CLOSE_GRACE)
const OVERSIZED = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", () => {
  process.stdout.write("x".repeat(2 * 1024 * 1024 + 64) + "\\n");
  setInterval(() => {}, 10000);
});
`;
// dies right away: must resolve the next ask promptly (closed / write failed), never wait out CALL_TIMEOUT
const EARLY_EXIT = "process.exit(3);";
// answers, but ignores stdin end (holds a timer): close must fire CLOSE_GRACE then SIGKILL
const NO_CLOSE = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  let r; try { r = JSON.parse(l); } catch (e) { return; }
  if (r.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n");
});
rl.on("close", () => { setInterval(() => {}, 1000); });
`;
// closes fd0 for real (fs.closeSync) then announces readiness on stdout: everything the
// parent sends after that readiness frame lands on a pipe with no reader (EPIPE is
// guaranteed, not raced). Child lingers on a timer: close must SIGKILL after CLOSE_GRACE
const DEAD_STDIN = `
const fs = require("fs");
fs.closeSync(0);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { ready: true } }) + "\\n");
setInterval(() => {}, 10000);
`;

const ask0 = (st) => st.ask(0, "initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "t", version: "1" }, capabilities: {} });

// 1) valid success: proper child, strict envelope ok, clean exit 0
await t("gate_valid_success", async () => {
  const st = spawnGate({}, [process.execPath, "-e", RESPONDER]);
  const a = st.strict(await ask0(st), 0);
  assert.ok(a.ok, "initialize answered with a strict envelope");
  assert.equal(a.fr.result.serverInfo.name, "fake-mcp");
  st.notify("notifications/initialized"); // owes no reply
  const b = st.strict(await st.ask(1, "ping"), 1);
  assert.ok(b.ok, "ping answered; suppression proven only by the final orphan==0");
  assert.deepEqual(b.fr.result, {});
  assert.equal(st.orphans, 0, "no unsolicited/duplicate frames in the session");
  const cl = await st.close();
  assert.equal(cl.code, 0, "clean exit after stdin end");
});

// 2) duplicate/unsolicited frame: counted, never silently dropped
await t("gate_counts_duplicate_frame", async () => {
  const st = spawnGate({}, [process.execPath, "-e", DUPLICATOR]);
  const a = st.strict(await ask0(st), 0);
  assert.ok(a.ok, "first answer delivered to the waiter");
  // the duplicate arrived in the same read: no live waiter for it -> counted
  assert.equal(st.orphans, 1, "duplicate frame counted, not silently dropped");
  const cl = await st.close();
  assert.equal(cl.code, 0, "close still clean");
});

// 3) oversized stdout: LOCAL_LIMIT answered, child SIGKILLed, session bounded
await t("gate_oversized_stdout_local_limit", async () => {
  const st = spawnGate({}, [process.execPath, "-e", OVERSIZED]);
  const t0 = Date.now();
  const s = st.strict(await st.ask(0, "ping"), 0);
  assert.ok(!s.ok);
  assert.match(s.why, /2 MiB cap/, "over-cap answer reported as the documented cap");
  assert.ok(Date.now() - t0 < 30000, "cap fires well before the request timeout");
  const cl = await st.close();
  assert.equal(cl.signal, "SIGKILL", "oversized child killed, session bounded");
});

// 4) child early exit: ask resolves promptly (closed or EPIPE), close of an
//    already-closed child resolves immediately with its code
await t("gate_child_early_exit", async () => {
  const st = spawnGate({}, [process.execPath, "-e", EARLY_EXIT]);
  const t0 = Date.now();
  const fr = await st.ask(0, "ping");
  const s = st.strict(fr, 0);
  assert.ok(!s.ok, "no answer from a dead child");
  assert.ok(fr.dead === "CHILD_CLOSED" || fr.dead === "CHILD_ERROR" || fr.dead === "STDIN_ERROR",
    "dead child answered promptly with a fixed reason");
  assert.ok(Date.now() - t0 < 15000, "resolved well before the request timeout");
  const c0 = Date.now();
  const cl = await st.close();
  assert.equal(cl.code, 3, "already-closed child: close resolves with its exit code");
  assert.ok(Date.now() - c0 < 1000, "close does not wait on a gone child");
});

// 5) close timeout: child ignores stdin end -> CLOSE_GRACE then SIGKILL, bounded
await t("gate_close_timeout_sigkill", async () => {
  const st = spawnGate({}, [process.execPath, "-e", NO_CLOSE]);
  const a = st.strict(await st.ask(0, "ping"), 0);
  assert.ok(a.ok, "ping answered first");
  const t0 = Date.now();
  const cl = await st.close();
  const dt = Date.now() - t0;
  assert.equal(cl.signal, "SIGKILL", "stubborn child is SIGKILLed after the grace");
  assert.ok(dt >= 4900 && dt <= 9000, "close bounded by CLOSE_GRACE + slack");
});

// 6) stdin really closed (child fs.closeSync(0), readiness frame only AFTER the close):
//    parent awaits readiness via ask(0), so every later write hits a reader-less pipe —
//    notify + ask get guaranteed EPIPE (fixed STDIN_ERROR), promptly, never raced;
//    the lingering child is SIGKILLed after CLOSE_GRACE (close = real 'close' only)
await t("gate_dead_stdin_before_ask_notify", async () => {
  const st = spawnGate({}, [process.execPath, "-e", DEAD_STDIN]);
  const r = st.strict(await st.ask(0, "ready"), 0);
  // readiness gate: envelope arrives (request buffered pre-close) or EPIPE already
  // resolved the waiter — both occur only AFTER the child closed fd0, both bounded
  if (r.ok) assert.deepEqual(r.fr.result, { ready: true });
  else assert.match(r.why, /closed before answer/);
  st.notify("notifications/initialized"); // reader gone: guaranteed EPIPE, handled, no throw
  const t0 = Date.now();
  const fr = await st.ask(1, "ping");
  assert.equal(fr.dead, "STDIN_ERROR", "fixed reason from the reader-less pipe");
  assert.ok(Date.now() - t0 < 10000, "resolved promptly, never waited out CALL_TIMEOUT");
  const c0 = Date.now();
  const cl = await st.close();
  assert.equal(cl.signal, "SIGKILL", "lingering child killed after the grace (stdin error was not process death)");
  assert.ok(Date.now() - c0 >= 4900 && Date.now() - c0 <= 9000, "close bounded by CLOSE_GRACE + slack");
});

console.error(`${checks - failures}/${checks} gate harness tests passed`);
process.exit(failures === 0 ? 0 : 1);
