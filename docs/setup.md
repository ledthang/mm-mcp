# Setup and credential lifecycle

How to run this server, point an MCP client at it, and give the authenticated tools a
credential. Nothing needs a package install. The login step is run by a human in a terminal;
the server itself never logs in.

> **`params._meta` (fixed locally, 2026-11-01):** the allowlists used to omit `_meta`, so a
> client that sent `params._meta` — including on `initialize` — was refused `-32602` and never
> opened a session. `_meta` is now accepted on `initialize`, `ping`, `tools/list` and
> `tools/call` when it is an object, and then ignored; a non-object `_meta` is still
> `-32602`. Covered by `scripts/stdio.test.mjs` (37 checks, passing). MCP Python SDK 2.0.0 in
> the Hermes venv completed initialize / tools/list / tools/call against this server (PASS,
> `2024-11-05`, 7 tools, no upstream calls), but that loaded no Hermes configuration, so no
> client connection — Hermes included — is certified, and the client configuration in §2
> remains **illustrative**. See [../README.md](../README.md) and
> [testing.md](testing.md).

## 1. Run it (nothing to install)

```sh
node src/server.mjs        # the MCP server, stdio in / stdio out
```

Requires Node.js 22 or newer (`package.json` engines `>=22`). No npm dependencies, so there
is no install step, no lockfile resolution and no build. `npm start` wraps the same command;
prefer `node` directly (§2). CI exercises Node 22 and 24 — that is the tested matrix, not a
claim about every other version.

## 2. Point an MCP client at it (illustrative configuration)

Start the server with the `node` binary and an absolute path, not through `npm`: `npm`
prints its own banner (`> mm-mcp@0.1.0 start`, update notices) onto stdout, and stdout is
the single stream carrying the JSON-RPC frames; a line-delimited client should only ever see
frames.

```json
{
  "mcpServers": {
    "mm-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mm-mcp/src/server.mjs"],
      "env": {
        "MM_STORE_CODE": "b2c_NNNNN_vi"
      }
    }
  }
}
```

Replace `/absolute/path/to/mm-mcp` with where the repository lives, and `b2c_NNNNN_vi` with
the store code you use — a generic placeholder, no particular store claimed or recommended.

**This block is a shape, not a verified connection.** No configured Hermes session was
opened, so it is not confirmed working in Hermes. `_meta` on any method (including
`initialize`) is now accepted when it is an object, so the old `-32602` blocker that broke
initializing clients is closed locally and unit-tested, and the MCP Python SDK 2.0.0 in the
Hermes venv did complete initialize / tools/list / tools/call against this server (PASS,
protocol `2024-11-05`, 7 tools, no upstream calls). That is an SDK handshake with no Hermes
configuration loaded — not a Hermes session. Verify a connection yourself before treating any
config here as working.

Timeouts worth knowing before you configure a client: one upstream request may take up to
25 s, and `mm_search_products` makes two of them in sequence, so allow roughly 50 s for a
search. A 30 s client timeout will cut off a search that is still legitimately running.

## 3. Environment variables

| Variable | Used by | Meaning | Default |
| --- | --- | --- | --- |
| `MM_STORE_CODE` | `mm_search_products`, `mm_get_product` | which guest store to query; format `b2c_` + 1–8 digits + `_vi` | none — required, no fallback |
| `MM_AUTH_FILE` | the five authenticated tools | path to the credential file | `$XDG_DATA_HOME/mm-mcp/auth.json`, else `~/.local/share/mm-mcp/auth.json` |
| `XDG_DATA_HOME` | auth path resolution | base for the default auth path | `~/.local/share` |
| `MM_LIVE_PARSE` | `scripts/account.test.mjs` only | set to `1` to enable the two anonymous live-parse checks | cleared by `npm test` |
| `MM_CONSUMER_FIXTURE_URL` | fixture mode | loopback URL of the synthetic upstream used by `scripts/consumer-acceptance.mjs`; internal to that runner | unset |

Only those exist. Nothing reads a proxy setting, a cookie jar or a browser profile.

## 4. Set up the credential (operator, interactive)

`npm run auth:setup` and `node scripts/auth-setup.mjs` are the same operator CLI. It is
**not** an MCP tool: the server exposes no login tool, so a client can never log in on your
behalf. It is also not read-only — it sends a mutation and writes a file (§5, and the note
at the top of this page).

Input rule: exactly one JSON object on stdin with the three keys `email`, `password`,
`store`, all strings. Anything else — extra keys, missing keys, wrong types, control
characters, command-line arguments — is rejected with `INVALID_INPUT` before any request is
made. Input is capped at 16 KiB and the read has a 10-second deadline. The bearer token is
**not** an input: it is what the `SignIn` mutation returns.

Do not put secrets in command-line arguments: argv is visible to other processes via `ps`,
is captured by shell history, and often ends up pasted into chat. The CLI accepts no
arguments for exactly that reason — pass the credential through stdin only.

Safe interactive example (Python stdlib, hidden prompts, JSON straight to the CLI's stdin).
Prompt time does not consume the CLI's 10-second stdin deadline, because the prompts finish
before the CLI is started. The wrapper propagates the CLI's exit code, so a failure is not
reported as success:

```sh
python3 - <<'PY'
import getpass
import json
import subprocess

credentials = {key: getpass.getpass(key + ": ") for key in ("email", "password", "store")}
proc = subprocess.run(
    ["node", "scripts/auth-setup.mjs"],
    input=json.dumps(credentials),
    capture_output=True,
    text=True,
)
print(proc.stdout.strip() or proc.stderr.strip())
raise SystemExit(proc.returncode)   # keep the CLI's exit code; do not swallow a failure
PY
```

`getpass` never echoes the password, nothing is written to a shell literal, and only the
fixed outcome (`AUTH_SAVED` or one error code) is printed. This example **is not run by
these docs** — running it performs a real login against the live endpoint, which is a
decision for the operator.

What the CLI does when you run it, in order. All three requests are POSTs to
`https://online.mmvietnam.com/graphql` with `redirect: "error"`, `credentials: "omit"`, and
no `Authorization` header except in the proof step:

1. `query AuthSetupConfig{recaptchaV3Config{website_key forms}}` — verify the form config.
2. If `forms` contains `CUSTOMER_LOGIN`, stop with `CHALLENGE_REQUIRED`. If the config is
   missing, malformed or the request fails, stop with `CONFIG_UNVERIFIED`. No bypass, and the
   CLI never tries to solve a challenge.
3. Exactly one `mutation SignIn($email:String!,$password:String!){generateCustomerTokenV2(…)}`.
4. Proof with the returned bearer: `query AuthSetupProof{customer{__typename} storeConfig{store_code}}`
   must answer `Customer` **and** the same store code you submitted.
5. Only then write the auth file: an exclusive, non-symlink temp file (mode 0600) in the
   target's own directory, synced and closed, then atomically renamed onto the target.

### What the storage check actually guarantees

Traced against `scripts/auth-setup.mjs` (`inspectParents`, `inspectTarget`, `storeAuth`) —
the guarantees are narrower than "every parent is private":

- **Immediate parent** (the directory holding `auth.json`): created if missing, must be a
  real directory (not a symlink), owned by the running user, and mode exactly `0700`.
- **Ancestors above it** (up to the filesystem root): created if missing with mode `0700`
  as limited by the process umask, and checked only for "is a real directory" and "is not a
  symlink". Their ownership and their mode are **not** checked — a group-writable ancestor
  is accepted, so the chain is not asserted to be private all the way up.
- **Target file**, if it already exists: must be an owned regular file at mode exactly
  `0600`, not a symlink.
- **Re-check before rename:** all parent identities (`dev:ino`) and the target identity are
  compared again; a swap between the first check and the rename fails the write. That is
  detection of an identity change, not protection against another process running as the
  *same* OS user — path-based filesystem APIs cannot give that.
- Nothing along the path is followed through a symlink, and a failed write leaves an existing
  auth file untouched; the temp file is removed where possible.
- `Set-Cookie` is never retained. Successful output is one word: `AUTH_SAVED` (exit 0); any
  failure prints one fixed code to stderr and exits 1.

## 5. After setup

- The server re-reads and re-proves the credential on **every** authenticated call. No
  restart is needed after setup or re-login.
- When a credential expires or is rejected, all five authenticated tools answer
  `REQUIRES_LOGIN` (the one actionable code). Rerun the setup CLI, then check with
  `mm_auth_status`.
- **Automatic refresh is not implemented.** The upstream SPA refreshes through a cookie; this
  server keeps no cookies, so refresh is manual by design.
- Keep the auth file out of version control (`.gitignore` already excludes `auth.json`).

## 6. Verify without the real endpoint

```sh
npm test
```

Everything in `npm test` is deterministic and never contacts `https://online.mmvietnam.com`:
suites answer from canned payloads and from local child processes over real stdio pipes, with
no external network. You can therefore confirm the server behaves before giving it any
credential. Note this is "no real endpoint / no external network", not "no sockets at all":
the separate `scripts/consumer-acceptance.mjs` runner binds a loopback HTTP fixture on
`127.0.0.1`. See [testing.md](testing.md).

## Notes on the source of these facts

`scripts/auth-setup.mjs` defines the request sequence, the limits (16 KiB, 10 s, the store
and bearer patterns) and the fixed codes. `src/account.mjs` defines reading and validating the
file at request time. [auth-lifecycle-contract.md](auth-lifecycle-contract.md) holds the
evidence record behind the login/refresh discussion — including what is *not* established
(actual token lifetime units, MFA policy, rotation semantics); its earlier "helper" metadata
labels came from a prior static pass and may be inaccurate. Nothing in this documentation pass
re-ran live probes or read credentials.
