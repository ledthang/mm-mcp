#!/usr/bin/env node
// mm-mcp stdio protocol tests: real spawned server, node:assert only, serial.
// One request -> at most one reply; timeouts resolve to null and drop the waiter.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");
const PV = "2024-11-05";
const opened = [];

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

function start() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  const waiters = [];
  const stderr = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let f;
      try {
        f = JSON.parse(line);
      } catch {
        f = { badFrame: line };
      }
      const w = waiters.shift(); // deliver to the only live waiter, else queue it
      if (w) {
        clearTimeout(w.timer);
        w.resolve(f);
      } else {
        frames.push(f);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(c));
  const api = {
    child,
    stderr,
    frames,
    write(raw) {
      child.stdin.write(raw);
    },
    // Oldest pending reply, or null after ms. A timed-out waiter is unregistered,
    // so it can never swallow a later frame (that was the stale-waiter bug).
    next(ms = 2000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve) => {
        const w = {
          resolve,
          timer: setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i !== -1) {
              waiters.splice(i, 1);
              resolve(null);
            }
          }, ms),
        };
        waiters.push(w);
      });
    },
    call(msg, ms) {
      api.write(JSON.stringify(msg) + "\n");
      return api.next(ms);
    },
    // Nothing may come back for these lines; the probe below proves the pipe is clean.
    async quiet(lines, ms = 250) {
      for (const l of lines) api.write(l.endsWith("\n") ? l : l + "\n");
      return (await api.next(ms)) === null;
    },
    init(id = 1) {
      return api.call({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PV, clientInfo: { name: "t", version: "1" }, capabilities: {} } });
    },
    ping(id = 2) {
      return api.call({ jsonrpc: "2.0", id, method: "ping" });
    },
    async exited() {
      try {
        child.stdin.end();
      } catch {}
      const code = await new Promise((res) => child.once("close", (c, sig) => res(c ?? sig)));
      return code;
    },
    stop() {
      try {
        child.stdin.end();
      } catch {}
      child.kill("SIGKILL");
    },
  };
  opened.push(api);
  return api;
}

// Fresh connected+initialized session.
async function live() {
  const c = start();
  const r = await c.init();
  assert.equal(r.result.protocolVersion, PV, "init in live()");
  return c;
}

async function main() {
  await t("initialize: protocolVersion + serverInfo + tools capability", async () => {
    const c = start();
    const r = await c.init();
    assert.equal(r.jsonrpc, "2.0");
    assert.equal(r.id, 1);
    assert.deepEqual(r.result.serverInfo, { name: "mm-mcp", version: "0.1.0" });
    assert.equal(typeof r.result.capabilities.tools, "object");
    c.stop();
  });

  await t("ping before initialize: -32600", async () => {
    const c = start();
    const r = await c.ping(5);
    assert.equal(r.error.code, -32600);
    assert.equal(r.id, 5);
    c.stop();
  });

  await t("tools/list before initialize: -32600", async () => {
    const c = start();
    const r = await c.call({ jsonrpc: "2.0", id: 6, method: "tools/list" });
    assert.equal(r.error.code, -32600);
    c.stop();
  });

  await t("initialize with unknown params member: -32602", async () => {
    const c = start();
    const r = await c.call({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: PV, clientInfo: { name: "t", version: "1" }, capabilities: {}, extra: true } });
    assert.equal(r.error.code, -32602);
    // failed initialize must not have changed state
    const p = await c.ping(8);
    assert.equal(p.error.code, -32600, "state unchanged after failed initialize");
    c.stop();
  });

  await t("initialize missing clientInfo.version: -32602, still un-initialized", async () => {
    const c = start();
    const r = await c.call({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: PV, clientInfo: { name: "t" }, capabilities: {} } });
    assert.equal(r.error.code, -32602);
    assert.equal((await c.ping(10)).error.code, -32600);
    c.stop();
  });

  await t("double initialize: -32600", async () => {
    const c = await live();
    const r = await c.init(11);
    assert.equal(r.error.code, -32600);
    c.stop();
  });

  await t("ping after initialize: empty result", async () => {
    const c = await live();
    const r = await c.ping(12);
    assert.deepEqual(r, { jsonrpc: "2.0", id: 12, result: {} });
    c.stop();
  });

  await t("ping with junk params: -32602", async () => {
    const c = await live();
    assert.equal((await c.call({ jsonrpc: "2.0", id: 13, method: "ping", params: { foo: 1 } })).error.code, -32602);
    assert.equal((await c.ping(14)).result && true, true, "session survives");
    c.stop();
  });

  await t("ping with array params: -32602", async () => {
    const c = await live();
    assert.equal((await c.call({ jsonrpc: "2.0", id: 15, method: "ping", params: [1, 2] })).error.code, -32602);
    c.stop();
  });

  await t("tools/list default params then cursor: catalog+account tools, no cursor", async () => {
    const c = await live();
    const a = await c.call({ jsonrpc: "2.0", id: 16, method: "tools/list" });
    assert.deepEqual(a.result.tools.map((t) => t.name), ["mm_search_products", "mm_get_product", "mm_auth_status", "mm_get_delivery_context", "mm_list_addresses", "mm_get_cart", "mm_cart_summary"], "seven tools: 2 guest catalog + 5 authenticated read");
    assert.equal(a.result.tools.length, 7, "exactly seven tools on one page");
    assert.ok(a.result.tools.every((t) => t.inputSchema.additionalProperties === false));
    const b = await c.call({ jsonrpc: "2.0", id: 17, method: "tools/list", params: { cursor: "next" } });
    assert.deepEqual(b.result.tools, a.result.tools); // same single page for any cursor string
    const bad = await c.call({ jsonrpc: "2.0", id: 18, method: "tools/list", params: { cursor: 42 } });
    assert.equal(bad.error.code, -32602);
    const unknown = await c.call({ jsonrpc: "2.0", id: 19, method: "tools/list", params: { limit: 5 } });
    assert.equal(unknown.error.code, -32602);
    c.stop();
  });

  await t("unknown method: -32601", async () => {
    const c = await live();
    assert.equal((await c.call({ jsonrpc: "2.0", id: 20, method: "cart/add", params: {} })).error.code, -32601);
    c.stop();
  });

  await t("malformed JSON: -32700 with id null, then recovery", async () => {
    const c = await live();
    c.write("{not json\n");
    const f = await c.next();
    assert.equal(f.error.code, -32700);
    assert.equal(f.id, null);
    const back = await c.ping(21);
    assert.deepEqual(back.result, {}, "recovered after parse error");
    c.stop();
  });

  await t("top-level JSON array: -32600 single-request only", async () => {
    const c = await live();
    c.write(JSON.stringify([{ jsonrpc: "2.0", id: 22, method: "ping" }]) + "\n");
    const f = await c.next();
    assert.equal(f.error.code, -32600);
    c.stop();
  });

  await t("wrong jsonrpc version: -32600", async () => {
    const c = start();
    const r = await c.call({ jsonrpc: "1.0", id: 23, method: "ping" });
    assert.equal(r.error.code, -32600);
    c.stop();
  });

  await t("bad id type: id null + -32600", async () => {
    const c = await live();
    const f = await c.call({ jsonrpc: "2.0", id: { o: 1 }, method: "ping" });
    assert.equal(f.id, null);
    assert.equal(f.error.code, -32600);
    c.stop();
  });

  await t("string id is echoed unchanged", async () => {
    const c = await live();
    assert.equal((await c.call({ jsonrpc: "2.0", id: "abc-9", method: "ping" })).id, "abc-9");
    c.stop();
  });

  await t("notifications: zero replies, no state change, no side effects", async () => {
    const c = await live();
    assert.equal(
      await c.quiet([
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "1" } }),
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ]),
      true,
      "no notification may be answered",
    );
    // initialize as notification-shaped (no id) must not re-initialize or error
    c.write("\n\n   \n");
    const probe = await c.ping(30);
    assert.deepEqual(probe.result, {}, "blank/whitespace lines ignored, session intact");
    c.stop();
  });

  await t("many small lines in ONE write: every request answered in order", async () => {
    const c = await live();
    const n = 200;
    const ids = [];
    for (let i = 1; i <= n; i += 1) ids.push(1000 + i);
    // one write: 200 requests must be split on byte 10 across chunk boundaries,
    // each answered exactly once, in order
    c.write(ids.map((i) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" })).join("\n") + "\n");
    const seen = [];
    for (let i = 0; i < n; i += 1) {
      const f = await c.next(4000);
      if (f === null) break;
      seen.push(f);
    }
    assert.equal(seen.length, n, "no dropped replies for " + n + " lines");
    seen.forEach((f, i) => {
      assert.equal(f.id, ids[i], "order preserved at index " + i);
      assert.deepEqual(f.result, {});
    });
    assert.equal(await c.next(250), null, "exactly " + n + " replies, no extras");
    assert.equal(c.stderr.join("").trim(), "", "no stderr noise");
    c.stop();
  });

  await t("overlong line (80KB, one write): one -32700 then recovery", async () => {
    const c = await live();
    const big = '{"jsonrpc":"2.0","id":77,"method":"ping","params":{"x":"' + "A".repeat(80000) + '"}}';
    c.write(big + "\n");
    const f = await c.next(4000);
    assert.equal(f.error.code, -32700, "oversized line answered once");
    assert.equal(await c.next(250), null, "no second reply for the oversized line");
    const back = await c.ping(78);
    assert.deepEqual(back.result, {}, "recovered after overlong line");
    c.stop();
  });

  await t("overlong line across 5 chunks: one -32700 then recovery", async () => {
    const c = await live();
    const head = '{"jsonrpc":"2.0","id":88,"method":"ping","params":{"x":"';
    c.write(head);
    for (let i = 0; i < 4; i += 1) c.write("B".repeat(40000));
    c.write('"}}\n');
    const f = await c.next(4000);
    assert.equal(f.error.code, -32700);
    assert.equal(await c.next(250), null, "single reply only");
    const back = await c.ping(89);
    assert.deepEqual(back.result, {}, "recovered after multi-chunk overlong line");
    c.stop();
  });

  await t("multibyte split across a byte boundary decodes intact", async () => {
    const c = await live();
    // split inside é (0xc3 0xa9): write one byte of the pair, then the rest
    const msg = JSON.stringify({ jsonrpc: "2.0", id: "héllo-9", method: "ping" });
    const bytes = Buffer.from(msg + "\n", "utf8");
    const at = bytes.indexOf(0xc3);
    assert.ok(at > 0 && bytes[at + 1] === 0xa9, "fixture really contains é bytes");
    c.write(bytes.subarray(0, at + 1));
    await new Promise((r) => setTimeout(r, 40));
    c.write(bytes.subarray(at + 1));
    const f = await c.next(2000);
    assert.equal(f.id, "héllo-9", "line reassembled across a split multibyte char");
    assert.deepEqual(f.result, {});
    c.stop();
  });

  await t("stdin close without trailing newline: last line answered, exit 0", async () => {
    const c = start();
    c.write(JSON.stringify({ jsonrpc: "2.0", id: 91, method: "ping" }).replace(/\n$/, ""));
    const code = await c.exited();
    assert.equal(code, 0, "clean exit on EOF");
    assert.equal(c.frames.length, 1, "unterminated line still answered");
    assert.equal(c.frames[0].error.code, -32600);
    assert.equal(c.stderr.join(""), "", "no fatal output");
  });

  await t("oversized initialize padded to cap + INVALID: -32700, session stays uninitialized", async () => {
    // Primary's repro: exact 65536-byte prefix is valid JSON + spaces (truncating to
    // the cap parses fine), yet the frame is oversized so it must NOT be accepted.
    const c = start();
    const initJson = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PV, clientInfo: { name: "t", version: "1" }, capabilities: {} } });
    const padded = initJson + " ".repeat(65536 - initJson.length); // exactly the cap, no newline
    assert.equal(Buffer.byteLength(padded, "utf8"), 65536, "fixture is exactly cap bytes");
    c.write(padded + "INVALID\n"); // one line, 65543 bytes => oversized
    const f = await c.next(4000);
    assert.equal(f.error.code, -32700, "oversized frame is a Parse error, never dispatched");
    assert.equal(f.id, null, "no id leaked from an undecoded frame");
    const p = await c.ping(7);
    assert.equal(p.error.code, -32600, "ping still not initialized: oversized init had no effect");
    c.stop();
  });

  await t("cap-boundary split: silence at cap, exactly one -32700 after crossing", async () => {
    const c = await live();
    const pingJson = JSON.stringify({ jsonrpc: "2.0", id: 55, method: "ping" });
    const atCap = pingJson + " ".repeat(65536 - pingJson.length); // exactly cap bytes
    c.write(atCap); // no newline yet: line is open, nothing may be answered
    assert.equal(await c.next(300), null, "exactly cap bytes: still open, no reply");
    c.write("x\n"); // crosses the cap => oversized, exactly one error
    const f = await c.next(4000);
    assert.equal(f.error.code, -32700, "crossing the cap yields exactly one Parse error");
    assert.equal(await c.next(300), null, "no second reply for the same line");
    const back = await c.ping(56);
    assert.deepEqual(back.result, {}, "recovered after cap-crossing line");
    c.stop();
  });

  console.error(`\n${checks - failures}/${checks} checks passed`);
  for (const c of opened) c.stop();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  for (const c of opened) c.stop();
  process.exit(1);
});
