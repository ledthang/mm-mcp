// MM Mega Market account: authenticated READ slice only (T3).
// Proven 2026-10-31 (primary): persistent browser restart stays on /dashboard with
// successful customer responses; the SPA sends an Authorization header with store
// b2c_70010_vi. Native fetch, fixed origin, GET with { Authorization, store } headers
// only. The query below is parse-verified via anonymous public replay (see
// scripts/account.test.mjs "public parse regression") — a query is never shipped on
// hope.
//
// Credential: { authorization, store } read per call from the auth file (MM_AUTH_FILE,
// default $XDG_DATA_HOME/mm-mcp/auth.json, else ~/.local/share/mm-mcp/auth.json). The
// file holds a secret and lives OUTSIDE git; this module never logs the token, never
// logs addresses, and never echoes an upstream body or a raw thrown message — every
// failure is one fixed code (+ optional safe detail), unknown throws are INTERNAL only.
//
// READ only: no login tool (setup uses an existing private session export), no cart,
// no product detail, no address selection. A saved default_shipping address is stored
// data — NEVER proof of the delivery address currently selected at cart/checkout.
// Context is live: authenticated:true + observed_at only after an actual upstream
// customer proof, every call. Guest catalog (catalog.mjs) and authenticated read are
// separate contexts; catalog stays an explicit guest MM_STORE_CODE view.

import { homedir } from "node:os";
import path from "node:path";
import { constants as fsC } from "node:fs";
import { open, lstat } from "node:fs/promises";

const GRAPHQL_URL = "https://online.mmvietnam.com/graphql";
const STORE_RE = /^b2c_[0-9]{1,8}_vi$/; // same store format as the catalog contract
const BEARER_RE = /^Bearer [\x21-\x7e]+$/; // "Bearer " + printable token, no second space
const MAX_AUTH_FILE_BYTES = 16 * 1024;
const TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// The proven shape, parameterized ONLY through JSON variables (never string
// interpolation): the observed constants currentPage:1/pageSize:20 become declared vars.
// Brace-balanced: customer and storeConfig are SIBLINGS at top level (previous version
// was one } short, so storeConfig nested inside customer and the document hit EOF).
export const ACCOUNT_QUERY = "query MMReadProof($currentPage:Int=1$pageSize:Int=20){customer{__typename addressesV2(currentPage:$currentPage pageSize:$pageSize){total_count total_pages addresses{id default_shipping city street custom_attributes{attribute_code value}}}}storeConfig{store_code store_name}}";

export const TOOLS = [
  {
    name: "mm_auth_status",
    description:
      "Live authentication proof for the MM account credential (auth file " +
      "MM_AUTH_FILE, default $XDG_DATA_HOME/mm-mcp/auth.json). Runs the proven " +
      "MMReadProof query (customer addressesV2 page 1 + storeConfig) on EVERY call — " +
      "no cached success. authenticated:true + observed_at are returned only after the " +
      "upstream actually shows a customer; missing or rejected credential is an error " +
      "(REQUIRES_LOGIN: re-export the private browser session, there is no login tool " +
      "here). The token itself is never printed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mm_get_delivery_context",
    description:
      "Verified store context for the authenticated account: store_code + store_name " +
      "live from storeConfig, cross-checked against the store in the auth file. " +
      "address_selection is NOT verified: a saved default_shipping address is stored " +
      "data, not proof of the delivery address currently selected in cart/checkout. " +
      "Read only: no address selection happens here. Takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mm_list_addresses",
    description:
      "Saved address book rows (authenticated, private tool use): id, default_shipping, " +
      "city, street, custom_attributes — live per call, no caching. No identity fields " +
      "(email/name/phone) and no orders. default_shipping is stored data, NOT the " +
      "delivery address currently selected at checkout. " +
      "page_index: 0-based, 0..40 (upstream currentPage = page_index + 1); " +
      "page_size: 1..20 (default 20).",
    inputSchema: {
      type: "object",
      properties: {
        page_index: { type: "integer", minimum: 0, maximum: 40, default: 0, description: "0-based page number; upstream currentPage = page_index + 1" },
        page_size: { type: "integer", minimum: 1, maximum: 20, default: 20 },
      },
      additionalProperties: false,
    },
  },
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// One fixed code (+ optional safe detail) per failure; upstream bodies, raw thrown
// messages and the credential never appear in a detail.
class AccountError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export function createAccount({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  // ---------------------------------------------------------------- auth file (secret)
  // Validate then read, trusting no step: parent checked with lstat (a symlinked
  // parent is refused, never followed) and must be owned by the running user with no
  // group/other access; the file itself opened O_NOFOLLOW. Missing / symlink / not a
  // directory / wrong owner / wrong mode / over cap / bad shape are ALL one
  // actionable code REQUIRES_LOGIN (re-export the session), detail names the problem
  // but never the token.
  function authFilePath() {
    const fromEnv = env.MM_AUTH_FILE;
    if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
    const data = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME !== ""
      ? env.XDG_DATA_HOME
      : path.join(homedir(), ".local", "share");
    return path.join(data, "mm-mcp", "auth.json");
  }

  async function loadAuth() {
    const file = authFilePath();
    const parent = path.dirname(file);
    let ps;
    try {
      ps = await lstat(parent); // no stat: a symlinked parent would silently redirect
    } catch {
      throw new AccountError("REQUIRES_LOGIN", `auth dir missing: ${parent}`);
    }
    if (ps.isSymbolicLink()) throw new AccountError("REQUIRES_LOGIN", `auth dir is a symlink, refusing: ${parent}`);
    if (!ps.isDirectory()) throw new AccountError("REQUIRES_LOGIN", `auth dir is not a directory: ${parent}`);
    if (typeof process.getuid === "function" && ps.uid !== process.getuid()) {
      throw new AccountError("REQUIRES_LOGIN", "auth dir is not owned by the running user");
    }
    if ((ps.mode & 0o077) !== 0) throw new AccountError("REQUIRES_LOGIN", `auth dir allows group/other access: ${parent}`);

    let fh;
    try {
      fh = await open(file, fsC.O_RDONLY | fsC.O_NOFOLLOW); // symlink => ELOOP, never followed
    } catch (e) {
      if (e && e.code === "ENOENT") throw new AccountError("REQUIRES_LOGIN", `auth file missing: ${file}`);
      if (e && e.code === "ELOOP") throw new AccountError("REQUIRES_LOGIN", `auth file is a symlink, refusing: ${file}`);
      throw new AccountError("REQUIRES_LOGIN", `auth file unreadable: ${file}`);
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new AccountError("REQUIRES_LOGIN", "auth file is not a regular file");
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        throw new AccountError("REQUIRES_LOGIN", "auth file is not owned by the running user");
      }
      if ((st.mode & 0o777) !== 0o600) throw new AccountError("REQUIRES_LOGIN", "auth file must be mode 600");
      const buf = Buffer.alloc(MAX_AUTH_FILE_BYTES + 1);
      let total = 0;
      while (total < buf.length) {
        const { bytesRead } = await fh.read(buf, total, buf.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total === 0) throw new AccountError("REQUIRES_LOGIN", "auth file is empty");
      if (total > MAX_AUTH_FILE_BYTES) throw new AccountError("REQUIRES_LOGIN", "auth file is over 16 KiB");
      let raw;
      try {
        raw = JSON.parse(buf.subarray(0, total).toString("utf8"));
      } catch {
        throw new AccountError("REQUIRES_LOGIN", "auth file is not valid JSON");
      }
      if (!isObj(raw) || Object.keys(raw).length !== 2 || typeof raw.authorization !== "string" || typeof raw.store !== "string") {
        throw new AccountError("REQUIRES_LOGIN", "auth file must hold exactly { authorization, store }");
      }
      if (!BEARER_RE.test(raw.authorization)) throw new AccountError("REQUIRES_LOGIN", "authorization must be 'Bearer <token>'");
      if (!STORE_RE.test(raw.store)) throw new AccountError("REQUIRES_LOGIN", "store fails the b2c_<digits>_vi format");
      return { authorization: raw.authorization, store: raw.store };
    } finally {
      await fh.close(); // credential stream always released
    }
  }

  // ---------------------------------------------------------------- one gql request
  // GET on the fixed origin; credential headers are internal (never echoed). Every
  // transport/status/size/JSON/graphql failure is exactly one fixed code; the response
  // stream is always drained before throwing (nothing dangles, no false success).
  // HTTP 401/403 and any explicit GraphQL authentication category are REQUIRES_LOGIN
  // and stay distinct from transport/timeout/schema failures.
  async function gql(auth, currentPage, pageSize) {
    const url = new URL(GRAPHQL_URL);
    url.searchParams.set("query", ACCOUNT_QUERY);
    url.searchParams.set("variables", JSON.stringify({ currentPage, pageSize }));
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { Authorization: auth.authorization, store: auth.store },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = e && typeof e === "object" ? e.name : undefined;
      if (name === "TimeoutError" || name === "AbortError") throw new AccountError("UPSTREAM_TIMEOUT");
      throw new AccountError("UPSTREAM_UNREACHABLE");
    }
    const release = async () => { if (res.body) { try { await res.body.cancel(); } catch { /* closed */ } } };
    if (!res.ok) {
      await release();
      if (res.status === 401 || res.status === 403) {
        throw new AccountError("REQUIRES_LOGIN", `HTTP ${res.status} credential rejected`);
      }
      throw new AccountError("UPSTREAM_HTTP_STATUS", `HTTP ${res.status}`);
    }
    const cl = Number(res.headers.get("content-length"));
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      await release();
      throw new AccountError("RESPONSE_TOO_LARGE");
    }
    if (!res.body) throw new AccountError("RESPONSE_NOT_JSON", "no response body");
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        try { await reader.cancel(); } catch { /* closed */ }
        const name = e && typeof e === "object" ? e.name : undefined;
        if (name === "TimeoutError" || name === "AbortError") throw new AccountError("UPSTREAM_TIMEOUT");
        throw new AccountError("UPSTREAM_UNREACHABLE");
      }
      if (r.done) break;
      size += r.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* closed */ }
        throw new AccountError("RESPONSE_TOO_LARGE");
      }
      parts.push(Buffer.from(r.value));
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new AccountError("RESPONSE_NOT_JSON");
    }
    if (!isObj(payload)) throw new AccountError("RESPONSE_NOT_JSON");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const authErrors = payload.errors.filter(
        (e) => isObj(e) && (
          (Array.isArray(e.categories) && e.categories.some((c) => typeof c === "string" && c.toUpperCase() === "AUTHENTICATION")) ||
          (isObj(e.extensions) && e.extensions.code === "UNAUTHENTICATED")),
      ).length;
      if (authErrors > 0) throw new AccountError("REQUIRES_LOGIN", `${authErrors} authentication error(s)`);
      throw new AccountError("GRAPHQL_ERRORS", `${payload.errors.length} error(s)`);
    }
    if (!isObj(payload.data)) throw new AccountError("RESPONSE_NOT_JSON", "no data object");
    return payload.data;
  }

  // ---------------------------------------------------------------- proofs / projection
  // Customer proof + store cross-check: the storeConfig answer MUST equal the store the
  // request was signed for; any malformed row fails closed (partial truth never shown).
  function proof(data, store) {
    const cust = data.customer;
    if (!isObj(cust)) throw new AccountError("REQUIRES_LOGIN", "HTTP 200 but no customer: not authenticated");
    if (cust.__typename !== "Customer") throw new AccountError("BAD_UPSTREAM_DATA", "customer.__typename");
    const sc = data.storeConfig;
    if (!isObj(sc) || typeof sc.store_code !== "string" || typeof sc.store_name !== "string") {
      throw new AccountError("BAD_UPSTREAM_DATA", "storeConfig");
    }
    if (sc.store_code !== store) throw new AccountError("STORE_MISMATCH", "storeConfig disagrees with the requested store");
    return sc;
  }

  // Structure is checked (object shape, required keys, list of key-holding entries,
  // unique ids); scalar TYPES are passed through untouched — id/city/street/value
  // types are not pinned from a capture, and unverified types must not be guessed
  // (primary verifies real types later).
  function pageProof(data, store) {
    const sc = proof(data, store);
    const av = data.customer.addressesV2;
    if (!isObj(av) || !Array.isArray(av.addresses)) throw new AccountError("BAD_UPSTREAM_DATA", "addressesV2");
    if (!isInt(av.total_count, 0, Number.MAX_SAFE_INTEGER)) throw new AccountError("BAD_UPSTREAM_DATA", "total_count");
    if (!isInt(av.total_pages, 0, Number.MAX_SAFE_INTEGER)) throw new AccountError("BAD_UPSTREAM_DATA", "total_pages");
    const rows = [];
    for (const a of av.addresses) {
      if (
        !isObj(a) ||
        !["id", "default_shipping", "city", "street", "custom_attributes"].every((k) => k in a) ||
        !Array.isArray(a.custom_attributes) ||
        !a.custom_attributes.every((c) => isObj(c) && "attribute_code" in c && "value" in c)
      ) {
        throw new AccountError("BAD_UPSTREAM_DATA", "address row");
      }
      if (rows.some((r) => r.id === a.id)) throw new AccountError("BAD_UPSTREAM_DATA", "duplicate address id");
      rows.push({ id: a.id, default_shipping: a.default_shipping, city: a.city, street: a.street, custom_attributes: a.custom_attributes });
    }
    return { sc, rows, av };
  }

  async function callTool(name, args) {
    try {
      if (!TOOLS.some((t) => t.name === name)) throw new AccountError("UNKNOWN_TOOL", String(name));
      if (!isObj(args)) throw new AccountError("INVALID_ARGS", "arguments must be an object");
      const allowed = name === "mm_list_addresses" ? ["page_index", "page_size"] : [];
      const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new AccountError("INVALID_ARGS", `unknown argument(s): ${unknown.join(", ")}`);
      const auth = await loadAuth(); // any local credential problem: REQUIRES_LOGIN, zero network
      if (name === "mm_auth_status") {
        const data = await gql(auth, 1, 20); // the proven proof, live, every call
        const sc = proof(data, auth.store);
        return {
          content: [{ type: "text", text: JSON.stringify({
            authenticated: true, store_code: sc.store_code, store_name: sc.store_name, observed_at: new Date().toISOString(),
          }) }],
        };
      }
      if (name === "mm_get_delivery_context") {
        const data = await gql(auth, 1, 20);
        const sc = proof(data, auth.store);
        return {
          content: [{ type: "text", text: JSON.stringify({
            store_code: sc.store_code,
            store_name: sc.store_name,
            address_selection: "NOT verified: a saved default_shipping address is stored data, not proof of the delivery address currently selected at cart/checkout",
            observed_at: new Date().toISOString(),
          }) }],
        };
      }
      // mm_list_addresses
      let pageIndex = 0;
      if ("page_index" in args) {
        if (!isInt(args.page_index, 0, 40)) throw new AccountError("INVALID_ARGS", "page_index must be an integer 0..40");
        pageIndex = args.page_index;
      }
      let pageSize = 20;
      if ("page_size" in args) {
        if (!isInt(args.page_size, 1, 20)) throw new AccountError("INVALID_ARGS", "page_size must be an integer 1..20");
        pageSize = args.page_size;
      }
      const data = await gql(auth, pageIndex + 1, pageSize); // translated only through JSON vars
      const { sc, rows, av } = pageProof(data, auth.store);
      return {
        content: [{ type: "text", text: JSON.stringify({
          addresses: rows,
          pagination: { page_index: pageIndex, page_size: pageSize, total_count: av.total_count, total_pages: av.total_pages },
          context: { store_code: sc.store_code, authenticated: true },
          observed_at: new Date().toISOString(),
        }) }],
      };
    } catch (e) {
      // Fixed code only. A raw thrown message (AccountError or not) may hold upstream
      // bodies, addresses or the token — never echoed, never logged; unknown throws
      // are exactly "INTERNAL".
      if (e instanceof AccountError) {
        return { content: [{ type: "text", text: e.detail ? `${e.code}: ${e.detail}` : e.code }], isError: true };
      }
      return { content: [{ type: "text", text: "INTERNAL" }], isError: true };
    }
  }

  return { callTool };
}
