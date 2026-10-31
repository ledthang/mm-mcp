// Minimal MCP stdio server: newline-delimited JSON-RPC 2.0 (T1 core + T2 catalog tool).
// Stdlib only + native fetch via src/catalog.mjs.
// Bytes split on byte 10, decoded to utf8 only once a line is complete (so a multibyte
// char split across chunks survives). A line over MAX_LINE_BYTES is NEVER dispatched - its
// kept head can still parse, and that is not validity. Oversized input is discarded until
// its newline, buying exactly one Parse error, then service resumes. One reply per line,
// written and awaited before the next bytes are read (backpressure, no promise queue).

import { pathToFileURL } from "node:url";
import { createCatalog, TOOLS } from "./catalog.mjs";

const catalog = createCatalog(); // native fetch, explicit MM_STORE_CODE read per call

const PROTOCOL_VERSION = "2024-11-05";
const MAX_LINE_BYTES = 64 * 1024;
const TOO_LONG = `Parse error: line longer than ${MAX_LINE_BYTES} bytes`;

const PARSE = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const INIT_KEYS = ["protocolVersion", "clientInfo", "capabilities"];
const LIST_KEYS = ["cursor"];
const CALL_KEYS = ["name", "arguments"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmpty = (v) => typeof v === "string" && v.length > 0;
const isId = (v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
const extraKeys = (params, allowed) => Object.keys(params).filter((k) => !allowed.includes(k));
const isBlank = (buf) => !buf.some((b) => b > 0x20); // blank/CRLF-only line: nothing to answer

const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });

// One complete, in-cap line -> reply envelope (awaited), or null when nothing may be
// written. Session state is an explicit argument: nothing here depends on `this`.
// tools/call awaits the catalog; every other reply is synchronous.
export async function dispatch(state, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return err(null, PARSE, "Parse error");
  }
  if (!isObj(msg)) return err(null, INVALID_REQUEST, "Invalid Request: one object per line");
  if (msg.jsonrpc !== "2.0") return err(null, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  if (!isNonEmpty(msg.method)) return err(null, INVALID_REQUEST, "method must be a non-empty string");
  if (!("id" in msg)) return null; // notification: no reply, and no state change
  if (!isId(msg.id)) return err(null, INVALID_REQUEST, "id must be a string or number");

  const id = msg.id;
  const params = msg.params ?? {};
  if (!isObj(params)) return err(id, INVALID_PARAMS, "params must be an object");
  if (msg.method !== "initialize" && !state.initialized) return err(id, INVALID_REQUEST, "not initialized");

  switch (msg.method) {
    case "initialize": {
      if (state.initialized) return err(id, INVALID_REQUEST, "already initialized");
      const extra = extraKeys(params, INIT_KEYS);
      if (extra.length) return err(id, INVALID_PARAMS, `unknown params: ${extra.join(", ")}`);
      if (!isNonEmpty(params.protocolVersion)) {
        return err(id, INVALID_PARAMS, "protocolVersion must be a non-empty string");
      }
      const info = params.clientInfo;
      if (!isObj(info) || !isNonEmpty(info.name) || !isNonEmpty(info.version)) {
        return err(id, INVALID_PARAMS, "clientInfo.name and clientInfo.version must be non-empty strings");
      }
      if (!isObj(params.capabilities)) return err(id, INVALID_PARAMS, "capabilities must be an object");
      state.initialized = true;
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "mm-mcp", version: "0.1.0" },
        capabilities: { tools: {} },
      });
    }
    case "ping": {
      if (Object.keys(params).length > 0) return err(id, INVALID_PARAMS, "ping takes no params");
      return ok(id, {});
    }
    case "tools/list": {
      const extra = extraKeys(params, LIST_KEYS);
      if (extra.length) return err(id, INVALID_PARAMS, `unknown params: ${extra.join(", ")}`);
      if ("cursor" in params && !isNonEmpty(params.cursor)) {
        return err(id, INVALID_PARAMS, "cursor must be a non-empty string");
      }
      return ok(id, { tools: TOOLS }); // single page: no cursor is ever issued
    }
    case "tools/call": {
      const extra = extraKeys(params, CALL_KEYS);
      if (extra.length) return err(id, INVALID_PARAMS, `unknown params: ${extra.join(", ")}`);
      if (!isNonEmpty(params.name)) return err(id, INVALID_PARAMS, "name must be a non-empty string");
      if (!TOOLS.some((t) => t.name === params.name)) return err(id, INVALID_PARAMS, `unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      if (!isObj(args)) return err(id, INVALID_PARAMS, "arguments must be an object");
      return ok(id, await catalog.callTool(params.name, args)); // upstream awaited; one reply per line
    }
    default:
      return err(id, METHOD_NOT_FOUND, `Unknown method: ${msg.method}`);
  }
}

// Byte-level newline loop over stdin. Returns when stdin ends.
export async function runStdio(input = process.stdin, output = process.stdout) {
  const state = { initialized: false };
  let tail = Buffer.alloc(0); // kept bytes of the open line, never more than the cap
  let oversized = false; // open line is over the cap: bytes dropped, awaiting its newline

  const writeLine = (env) =>
    new Promise((res, rej) => output.write(`${JSON.stringify(env)}\n`, (e) => (e ? rej(e) : res())));

  const answer = async (line) => { // whole, in-cap lines only
    const envelope = await dispatch(state, line.toString("utf8"));
    if (envelope) await writeLine(envelope);
  };

  for await (const chunk of input) {
    const buf = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
    let start = 0;
    let nl;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const line = buf.subarray(start, nl);
      // oversized: cap blown by an earlier chunk; length > cap: whole oversized line in this
      // chunk. Either way exactly one error, never a dispatch.
      if (oversized || line.length > MAX_LINE_BYTES) await writeLine(err(null, PARSE, TOO_LONG));
      else if (!isBlank(line)) await answer(line);
      start = nl + 1;
      oversized = false;
    }
    const rest = buf.subarray(start); // no newline here: still the same open line
    if (rest.length > MAX_LINE_BYTES) {
      oversized = true;
      tail = Buffer.alloc(0); // head may parse, so keeping it would risk a false accept
    } else {
      tail = Buffer.from(rest); // copy so handled bytes are not kept alive by the slice
    }
  }
  // EOF: an unterminated oversized line still owes exactly one error.
  if (oversized) await writeLine(err(null, PARSE, TOO_LONG));
  else if (tail.length > 0) await answer(tail);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runStdio().catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}
