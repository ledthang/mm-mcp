#!/usr/bin/env python3
"""Extract complete add/update cart GraphQL documents from supplied public JS chunks.

Stdlib only. Read-only over public bundles (no network, no private auth/env/vault/config).
Handles BOTH JS quote styles ('...' and "..."), each storing escaped newlines as the
two-character sequence backslash-n. Decoded documents are written COMPLETE (never
truncated) to a fresh PRIVATE, unpredictable artifact directory (mode 0700, tempfile.mkdtemp);
the artifact file is created via os.open(O_CREAT|O_EXCL, 0600) so an attacker-placed
symlink at any predictable path is never followed. The old shared /tmp/mm-cart-operations.json
is NOT reused. Source bytes are decoded with STRICT UTF-8 (fails closed on invalid input
rather than emitting U+FFFD replacements that would shift byte offsets). The script ends with
assert-based self-checks, so running this file IS the required runnable check; stdout prints
only counts/checks, never the source bundles or operation documents.
"""
import ast
import hashlib
import json
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.abspath(os.path.join(ROOT, os.pardir, "mm-public-auth"))

# Either quote style; escapes honoured (\\ then any char), closing quote must match.
LITERAL_RE = re.compile(r"(['\"])((?:\\.|(?!\1)[^\\])*)\1", re.S)
OP_RE = re.compile(r"mutation\s+(AddProductToCart|AddItemToCart|updateItemInCart)\b")


def decode(quote, body):
    # Double-quoted JS literal is JSON-compatible once re-quoted; single-quoted is not
    # (JSON forbids \'-escaped apostrophes), so use ast for those.
    return json.loads('"' + body + '"') if quote == '"' else ast.literal_eval("'" + body + "'")


def sources():
    names = [
        "vendors~RootCmp_PRODUCT__default.6124070c293c786bc499.js",
        "RootCmp_PRODUCT__default.69076e524fe78a5faa74.js",
        "RootCmp_SEARCH__default.d9f8e2c57e1715c1fac3.js",
        "RootCmp_CATEGORY__default.128ba67e6de0592532c9.js",
    ]
    return [n for n in names if os.path.isfile(os.path.join(PUB, n))]


def main():
    collected = []
    decode_failures = 0
    quote_style_counts = {"'": 0, '"': 0}

    for rel in sources():
        path = os.path.join(PUB, rel)
        raw = open(path, "rb").read()
        # STRICT UTF-8: the public sources are valid UTF-8. Fail closed on any invalid
        # byte (UnicodeDecodeError aborts the run) rather than errors="replace", which
        # would silently map bad bytes to U+FFFD and shift the byte offsets we bind to.
        text = raw.decode("utf-8")
        for m in LITERAL_RE.finditer(text):
            quote, body = m.group(1), m.group(2)
            if len(body) < 80:
                continue
            op = OP_RE.search(body)
            if not op:
                continue
            try:
                doc = decode(quote, body)
            except Exception:
                decode_failures += 1
                continue
            if not OP_RE.search(doc):
                continue
            quote_style_counts[quote] += 1
            collected.append(
                {
                    "source": rel,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    # Byte offset of the opening quote: chars before it, UTF-8 encoded.
                    "byte_offset": len(text[: m.start()].encode("utf-8")),
                    "quote_style": quote,
                    "operation": op.group(1),
                    "document": doc,
                }
            )

    # Collapse identical (source, operation, document) repeats; keep first occurrence.
    seen = set()
    docs = []
    for item in collected:
        key = (item["source"], item["operation"], item["document"])
        if key in seen:
            continue
        seen.add(key)
        docs.append(item)

    # Sort for stable output: operation, then source, then offset.
    docs.sort(key=lambda d: (d["operation"], d["source"], d["byte_offset"]))

    payload = {
        "generated_by": "scripts/cart_contract_extract.py",
        "scope": "static read of supplied public JS chunks only; no network, no private auth/env/vault/config",
        "quote_styles_seen": quote_style_counts,
        "decode_failures": decode_failures,
        "documents": docs,
    }
    # Secure artifact creation: fresh PRIVATE dir (mkdtemp, mode 0700, unpredictable),
    # artifact file created inside via O_CREAT|O_EXCL|O_NOFOLLOW (mode 0600) so an
    # attacker-placed symlink at a predictable name is never followed. Never reuse
    # /tmp/mm-cart-operations.json (the old predictable shared path).
    out_dir = tempfile.mkdtemp(prefix="mm-cart-operations-")
    OUT = os.path.join(out_dir, "mm-cart-operations.json")
    fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)

    by_op = {}
    for d in docs:
        by_op[d["operation"]] = by_op.get(d["operation"], 0) + 1
    print("documents written:", len(docs), "-> <private-dir>/mm-cart-operations.json")
    for op in ("AddProductToCart", "AddItemToCart", "updateItemInCart"):
        print(f"count {op}: {by_op.get(op, 0)}")
    print("quote styles:", quote_style_counts, "decode_failures:", decode_failures)

    # ---- self-checks ----
    assert by_op.get("AddProductToCart", 0) == 1, "expected exactly one AddProductToCart"
    assert by_op.get("AddItemToCart", 0) >= 1, "no AddItemToCart found"
    assert by_op.get("updateItemInCart", 0) >= 2, "expected >=2 updateItemInCart variants"
    assert decode_failures == 0, f"undecodable literals: {decode_failures}"

    # Selected (single-UID) update variants: must identify the line by cart_item_uid and
    # $quantity: Float!, and must never use cart_item_id.
    single_uid = [d for d in docs if d["operation"] == "updateItemInCart" and "$itemId: ID!" in d["document"]]
    assert len(single_uid) == 3, f"expected 3 single-UID update variants, got {len(single_uid)}"
    for d in single_uid:
        assert "cart_item_uid" in d["document"], d["source"]
        assert "$quantity: Float!" in d["document"], d["source"]
        assert "cart_item_id" not in d["document"], f"cart_item_id leaked: {d['source']}"
        # COMPLETE document retained: ends with the closing brace of the mutation.
        assert d["document"].strip().endswith("}"), f"truncated doc: {d['source']}"
        assert re.search(r"updateCartItems\(\s*input:", d["document"]), d["source"]

    # List-input update variant (cart_items passed as a variable) is excluded from the
    # single-UID assertion above and must not claim a cart_item_uid binding.
    list_input = [d for d in docs if d["operation"] == "updateItemInCart" and "$cartItems:" in d["document"]]
    assert len(list_input) == 3, f"expected 3 list-input update variants, got {len(list_input)}"
    for d in list_input:
        assert "$cartItems: [CartItemUpdateInput!]!" in d["document"], d["source"]
        assert "cart_item_uid" not in d["document"], d["source"]

    # Add documents: every one is rooted at addProductsToCart; root field present, no invented ops.
    for d in docs:
        if d["operation"] in ("AddProductToCart", "AddItemToCart"):
            assert re.search(r"addProductsToCart\(", d["document"]), d["source"]
    # add/update both found and no doc was capped: longest retained equals its own length.
    assert all(len(d["document"]) > 100 for d in docs)
    assert not any("[TRUNCATED]" in d["document"] for d in docs)

    # Secure creation: private dir (0700) + artifact (0600), not a symlink, and the
    # path is NOT the old predictable /tmp/mm-cart-operations.json shared file.
    assert os.stat(out_dir).st_mode & 0o777 == 0o700, f"artifact dir not private: {oct(os.stat(out_dir).st_mode & 0o777)}"
    assert not os.path.islink(OUT), "artifact path is a symlink"
    assert oct(os.stat(OUT).st_mode & 0o777) == "0o600", f"artifact mode not 0600: {oct(os.stat(OUT).st_mode & 0o777)}"
    assert OUT != "/tmp/mm-cart-operations.json", "must not write the old predictable shared path"
    assert os.path.isabs(OUT) and OUT.startswith(tempfile.gettempdir() + os.sep), "artifact must live under a temp dir"

    print("SELFCHECK OK")
    print("artifact dir:", out_dir, "(mode 0700, private, per-run; not the old /tmp/mm-cart-operations.json)")
    print("artifact:", OUT, "(mode 0600)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
