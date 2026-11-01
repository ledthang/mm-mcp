#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnGate } from "./account-live.mjs";
import { CARD_QUERY, ENRICH_QUERY, DETAIL_QUERY } from "../src/catalog.mjs";
import { ACCOUNT_QUERY, CART_QUERY } from "../src/account.mjs";

const SELF = fileURLToPath(import.meta.url);
const SERVER = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const STORE = "b2c_10010_vi";
const READ_TOOLS = ["mm_search_products", "mm_get_product", "mm_auth_status",
  "mm_get_delivery_context", "mm_list_addresses", "mm_get_cart", "mm_cart_summary"];
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (!isMain && process.env.MM_CONSUMER_FIXTURE_URL) {
  const endpoint = new URL(process.env.MM_CONSUMER_FIXTURE_URL);
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.equal(endpoint.protocol, "http:");
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const source = new URL(input);
    assert.equal(source.origin, "https://online.mmvietnam.com");
    assert.equal(source.pathname, "/graphql");
    assert.equal(init.method ?? "GET", "GET");
    assert.match(source.searchParams.get("query"), /^query /);
    const target = new URL(endpoint);
    target.search = source.search;
    return nativeFetch(target, { ...init, redirect: "error" });
  };
}

const money = (value) => ({ value, currency: "VND" });
const product = (id, sku, unit = "Box", stock = "IN_STOCK") => ({
  id, sku, name: `Synthetic ${sku}`, url_key: sku.toLowerCase(), unit_ecom: unit,
  mm_qty_step: 1, stock_status: stock,
  price: { regularPrice: { amount: money(30000) } },
  price_range: { maximum_price: { final_price: money(28000), regular_price: money(30000) } },
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "mm-consumer-"));
  let http;
  try {
    const authFile = path.join(directory, "synthetic.json");
    await writeFile(authFile, JSON.stringify({ authorization: "Bearer synthetic-fixture-only", store: STORE }), { mode: 0o600 });
    const products = [product(1, "EGGS-A"), product(2, "EGGS-B"), product(3, "RICE", "Kg"), product(4, "UNAVAILABLE", "Box", "OUT_OF_STOCK")];
    const lines = [
      { uid: "protected-weight", quantity: 0.5, product: { sku: "RICE", name: "Synthetic protected rice" }, prices: { price: money(28000), row_total: money(14000) } },
      { uid: "protected-other", quantity: 1, product: { sku: "UNRELATED", name: "Synthetic unrelated line" }, prices: { price: money(7000), row_total: money(7000) } },
    ];
    const originalLines = structuredClone(lines);
    const state = { requests: 0, rejected: 0, fault: null, lines, originalLines };
    http = createServer((request, response) => {
      state.requests += 1;
      try {
        assert.equal(request.method, "GET");
        assert.equal(request.headers.store, STORE);
        const url = new URL(request.url, "http://127.0.0.1");
        const query = url.searchParams.get("query");
        const variables = JSON.parse(url.searchParams.get("variables"));
        let data;
        if (query === CARD_QUERY) {
          assert.equal(request.headers.authorization, undefined);
          const items = variables.inputText === "empty" ? [] : products;
          data = { products: { items, total_count: items.length, page_info: { total_pages: items.length ? 1 : 0 } } };
        } else if (query === ENRICH_QUERY) {
          assert.equal(request.headers.authorization, undefined);
          data = { products: { items: products.filter((item) => variables.skus.includes(item.sku)) } };
        } else if (query === DETAIL_QUERY) {
          assert.equal(request.headers.authorization, undefined);
          let items = products.filter((item) => item.url_key === variables.urlKey);
          if (variables.urlKey === "ambiguous") items = products.slice(0, 2);
          data = { products: { items } };
        } else {
          assert.ok([ACCOUNT_QUERY, CART_QUERY].includes(query));
          assert.equal(request.headers.authorization, "Bearer synthetic-fixture-only");
          data = {
            customer: { __typename: "Customer", addressesV2: { total_count: 1, total_pages: 1, addresses: [
              { id: 1, default_shipping: true, city: "Synthetic city", street: ["Synthetic street"], custom_attributes: [] },
            ] } },
            storeConfig: { store_code: state.fault === "store" ? "b2c_999_vi" : STORE, store_name: "Synthetic store" },
          };
          if (query === CART_QUERY && state.fault !== "missing-cart") {
            data.customerCart = { total_quantity: 1.5, items: lines,
              prices: { subtotal_excluding_tax: money(21000), grand_total: money(23000) },
              shipping_addresses: [{ selected_shipping_method: { method_title: "Synthetic delivery", amount: money(2000) } }] };
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(state.fault === "graphql" ? { errors: [{ message: "synthetic failure" }] } : { data }));
      } catch {
        state.rejected += 1;
        response.writeHead(400);
        response.end("fixture rejected request");
      }
    });
    await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    return { state, env: { MM_AUTH_FILE: authFile, MM_STORE_CODE: STORE,
      MM_CONSUMER_FIXTURE_URL: `http://127.0.0.1:${http.address().port}/graphql` },
    async close() {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    http?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const blocked = (code) => ({ blocked: true, code });
function propose(observation, need, conversion, now) {
  if (!Number.isFinite(need.required) || !Number.isFinite(need.available) || need.required < 0 || need.available < 0) return blocked("INVALID_NEED");
  const candidates = observation.products.filter((item) => !need.sku || item.sku === need.sku);
  if (candidates.length !== 1) return blocked(candidates.length ? "AMBIGUOUS_PRODUCT" : "NO_PRODUCT");
  const item = candidates[0];
  const observed = Date.parse(observation.observed_at);
  if (!Number.isFinite(observed) || observed > now || now - observed > 60000) return blocked("STALE_OBSERVATION");
  if (item.stock_status !== "IN_STOCK") return blocked("STOCK_UNCONFIRMED");
  if (observation.context.authenticated !== false || observation.price_status !== "catalog-observed-not-guaranteed-payable") return blocked("PRICE_CONTEXT_UNKNOWN");
  if (!conversion || conversion.sku !== item.sku || conversion.store !== observation.context.store_code || conversion.needUnit !== need.unit || conversion.productUnit !== item.unit || conversion.source !== "synthetic-explicit" || !Number.isFinite(conversion.perUnit) || conversion.perUnit <= 0) return blocked("UNKNOWN_PACKAGE_CONVERSION");
  const quantity = Math.ceil(Math.max(0, need.required - need.available) / conversion.perUnit / item.quantity_step) * item.quantity_step;
  if (!Number.isSafeInteger(quantity) || quantity < 0) return blocked("INVALID_QUANTITY");
  return { blocked: false, sku: item.sku, quantity, approvalRequired: true, executable: false };
}

async function acceptance(live) {
  const upstream = live ? null : await fixture();
  const session = spawnGate(live ? { ...process.env } : upstream.env,
    [process.execPath, ...(!live ? ["--import", SELF] : []), SERVER]);
  let requestId = 0;
  let checks = 0;
  let failed = false;
  const check = (test) => { test(); checks += 1; };
  const rpc = async (method, params) => {
    const id = ++requestId;
    const reply = session.strict(await session.ask(id, method, params), id);
    assert.equal(reply.ok, true);
    return reply.fr;
  };
  const call = async (name, args = {}, expectedError = null) => {
    const frame = await rpc("tools/call", { name, arguments: args });
    assert.equal(frame.error, undefined);
    const result = frame.result;
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const text = result.content[0].text;
    if (expectedError) {
      assert.equal(result.isError, true);
      const failure = blocked(text.split(":", 1)[0]);
      assert.deepEqual(failure, blocked(expectedError));
      checks += 1;
      return failure;
    }
    assert.notEqual(result.isError, true);
    const value = JSON.parse(text);
    const observed = Date.parse(value.observed_at);
    check(() => assert.ok(Number.isFinite(observed) && observed >= session.spawnedAt && observed <= Date.now()));
    return value;
  };
  try {
    const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "grocery-consumer-acceptance", version: "1" }, capabilities: {} });
    check(() => {
      assert.equal(initialized.result.protocolVersion, "2024-11-05");
      assert.equal(initialized.result.serverInfo.name, "mm-mcp");
    });
    session.notify("notifications/initialized");
    const listed = await rpc("tools/list", {});
    check(() => assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [...READ_TOOLS].sort()));
    const search = await call("mm_search_products", { query: live ? "gạo" : "synthetic", page_size: 10 });
    check(() => {
      assert.ok(Array.isArray(search.products));
      assert.equal(search.context.authenticated, false);
      assert.equal(search.price_status, "catalog-observed-not-guaranteed-payable");
      assert.ok(search.products.every((item) => typeof item.stock_status === "string" && Number.isFinite(item.price_vnd) && item.price_vnd >= 0));
    });
    if (search.products.length) {
      const first = search.products[0];
      const detail = await call("mm_get_product", { url_key: first.url_key, expected_sku: first.sku });
      check(() => {
        assert.equal(detail.product.sku, first.sku);
        assert.deepEqual(detail.context, search.context);
        assert.equal(detail.price_status, search.price_status);
      });
    }
    const auth = await call("mm_auth_status");
    const delivery = await call("mm_get_delivery_context");
    const addresses = await call("mm_list_addresses", { page_index: 0, page_size: 5 });
    const cart = await call("mm_get_cart");
    const summary = await call("mm_cart_summary");
    check(() => {
      assert.equal(auth.authenticated, true);
      assert.equal(delivery.store_code, auth.store_code);
      assert.match(delivery.address_selection, /^NOT verified:/);
      assert.equal("addresses" in delivery, false);
      for (const value of [addresses, cart, summary]) assert.deepEqual(value.context, { store_code: auth.store_code, authenticated: true });
      assert.ok(Array.isArray(addresses.addresses));
      assert.ok(Array.isArray(cart.items));
      assert.ok(cart.items.every((item) => Number.isFinite(item.quantity) && item.quantity > 0));
      assert.ok(Number.isSafeInteger(summary.line_count) && summary.line_count >= 0);
      for (const value of [cart, summary]) {
        assert.ok(Number.isFinite(value.total_quantity) && value.total_quantity >= 0);
        assert.match(value.price_status, /^cart-observed-not-guaranteed-payable/);
        assert.match(value.shipping.note, /NOT verified/);
      }
    });
    if (!live) {
      const profile = { synthetic: true, approvalRequired: true, needs: [{ sku: "EGGS-A", required: 6, available: 2, unit: "egg" }] };
      const need = profile.needs[0];
      const conversion = { sku: need.sku, store: STORE, needUnit: "egg", productUnit: "Box", perUnit: 10, source: "synthetic-explicit" };
      const now = Date.now();
      const decision = (observation, requested, mapping) => propose(observation, requested, mapping, now);
      check(() => {
        assert.deepEqual(decision(search, { ...need, sku: null }, null), blocked("AMBIGUOUS_PRODUCT"));
        assert.deepEqual(decision(search, need, null), blocked("UNKNOWN_PACKAGE_CONVERSION"));
        assert.deepEqual(decision(search, need, { ...conversion, productUnit: "Kg" }), blocked("UNKNOWN_PACKAGE_CONVERSION"));
        assert.deepEqual(decision(search, { ...need, sku: "absent" }, conversion), blocked("NO_PRODUCT"));
        assert.deepEqual(decision(search, { ...need, sku: "UNAVAILABLE" }, conversion), blocked("STOCK_UNCONFIRMED"));
        assert.deepEqual(decision({ ...search, observed_at: new Date(now - 60001).toISOString() }, need, conversion), blocked("STALE_OBSERVATION"));
        assert.deepEqual(decision(search, { ...need, required: NaN }, conversion), blocked("INVALID_NEED"));
        assert.deepEqual(decision(search, need, conversion), { blocked: false, sku: "EGGS-A", quantity: 1, approvalRequired: true, executable: false });
        assert.equal(profile.approvalRequired, true);
        assert.equal(cart.items[0].quantity, 0.5);
        assert.equal(cart.total_quantity, 1.5);
        assert.equal(summary.total_quantity, 1.5);
        assert.equal(cart.totals.grand_total_vnd, 23000);
        assert.equal(addresses.addresses[0].default_shipping, true);
      });
      const rice = { sku: "RICE", required: 1, available: 0.5, unit: "kg" };
      check(() => assert.equal(decision(search, rice, { ...conversion, sku: "RICE", needUnit: "kg", productUnit: "Kg", perUnit: 1 }).quantity, 1));
      await call("mm_get_product", { url_key: "ambiguous" }, "MULTIPLE_PRODUCTS");
      await call("mm_get_product", { url_key: "eggs-a", expected_sku: "EGGS-B" }, "SKU_MISMATCH");
      const empty = await call("mm_search_products", { query: "empty" });
      check(() => assert.deepEqual(decision(empty, need, conversion), blocked("NO_PRODUCT")));
      for (const [fault, code] of [["store", "STORE_MISMATCH"], ["missing-cart", "REQUIRES_LOGIN"], ["graphql", "GRAPHQL_ERRORS"]]) {
        upstream.state.fault = fault;
        await call("mm_get_cart", {}, code);
      }
      upstream.state.fault = null;
      const before = upstream.state.requests;
      const invalid = await call("mm_get_cart", { quantity: 0.5 }, "INVALID_ARGS");
      check(() => assert.equal(invalid.blocked, true));
      for (const name of ["mm_add_to_cart", "mm_update_cart", "mm_remove_from_cart", "mm_checkout"]) {
        const denied = await rpc("tools/call", { name, arguments: {} });
        check(() => assert.equal(denied.error.code, -32602));
      }
      check(() => assert.equal(upstream.state.requests, before));
      const after = await call("mm_get_cart");
      check(() => {
        assert.deepEqual(after.items, cart.items);
        assert.deepEqual(upstream.state.lines, upstream.state.originalLines);
        assert.equal(upstream.state.rejected, 0);
      });
    }
    return { live, fixture: !live, passed: true, checks, products: search.products.length,
      detail_checked: search.products.length > 0, addresses: addresses.addresses.length, cart_lines: cart.items.length,
      summary_lines: summary.line_count, shopping_certified: false };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const closed = await session.close();
    await upstream?.close();
    if (!failed) {
      assert.equal(closed.code, 0);
      assert.equal(session.stderrClean, true);
      assert.equal(session.orphans, 0);
    }
  }
}

if (isMain) {
  const args = process.argv.slice(2);
  const live = args.length === 1 && args[0] === "--live-readonly";
  try {
    assert.ok(args.length === 0 || live);
    console.log(JSON.stringify(await acceptance(live)));
  } catch (error) {
    if (!live) console.error(error);
    console.log(JSON.stringify({ live, fixture: !live, passed: false, shopping_certified: false }));
    process.exitCode = 1;
  }
}
