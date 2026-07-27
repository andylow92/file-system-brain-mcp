# Sharing one vault with agents on other machines (optional SPIFFE auth)

fsbrain is local-first, and stays that way: **auth is off by default and nothing
changes until you enable it.** This document is for the moment you want _one_
vault — one search index, one review queue, one audit log — shared by agents
running on other machines and networks.

The model is hub-and-spoke:

```
             agent laptop A                agent server B
        ┌─────────────────────┐       ┌─────────────────────┐
        │ MCP host (Claude,   │       │ any MCP host        │
        │ Cursor, OpenClaw…)  │       │                     │
        │   └─ fsbrain-mcp    │       │   └─ fsbrain-mcp    │
        │      (proxied mode) │       │      (proxied mode) │
        └──────────┬──────────┘       └──────────┬──────────┘
                   │  HTTPS + SPIFFE identity    │
                   └──────────────┬──────────────┘
                                  ▼
                     ┌─────────────────────────┐
                     │  the hub: apps/api      │
                     │  vault · index · queue  │
                     │  audit log · events     │
                     └─────────────────────────┘
```

Each agent machine runs the stdio MCP server in **proxied mode**
(`API_BASE_URL=https://vault.example.com`); the hub owns the state. Writes keep
their optimistic-concurrency guarantees (`etag` + 409), all proposals land in
the one review queue, and — once auth is on — the audit log attributes every
write to a **verified identity** instead of a self-declared header.

## Tier 0: private network, no auth

If all machines can share a VPN/tailnet (Tailscale, WireGuard), you need
nothing from this document:

```bash
# On the hub
HOST=0.0.0.0 CONTENT_ROOT=/srv/vault npm run dev:api

# On each agent machine
API_BASE_URL=http://<tailnet-ip>:3001 MCP_ACTOR=agent:laptop-a fsbrain-mcp
```

Auth here is network membership. The rest of this document is for when that
isn't enough — public exposure, per-agent permissions, or trustworthy
attribution.

## What enabling auth changes

Enable it in the web UI (shield icon → _Vault access_) or from the hub machine:

```bash
curl -X PUT http://127.0.0.1:3001/api/auth \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "trustDomain": "example.org",
    "audience": "fsbrain",
    "jwks": { "file": "/etc/fsbrain/bundle.jwks.json" },
    "defaultAccess": "readwrite",
    "agents": [
      { "id": "spiffe://example.org/readonly/", "match": "prefix", "access": "read" },
      { "id": "spiffe://example.org/agent/operator", "match": "exact", "access": "admin" }
    ]
  }'
```

The behavior contract:

| Situation                           | Behavior                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth **disabled** (default)         | Exactly the pre-auth API. One exception: `PUT /api/auth` is **loopback-only**, so a remotely exposed vault's auth settings can never be hijacked.            |
| Enabled, request from loopback      | Exempt while `allowLoopback` is on (default) — the local web UI and embedded MCP keep working with zero setup. Loopback acts as the owner (`admin`).         |
| Enabled, remote request             | Must present a SPIFFE identity: an `Authorization: Bearer <JWT-SVID>` or an mTLS client certificate (X.509-SVID). Verified id → access level via your rules. |
| Verified write                      | The audit log, live events, and proposals record the **SPIFFE ID** as the actor; a client-sent `X-Actor` is ignored.                                         |
| `GET /health`                       | Never requires credentials (load balancers), but hides `contentRoot` from remote callers while auth is on.                                                   |
| Changing settings (`PUT /api/auth`) | Loopback, or a verified identity with `admin` access.                                                                                                        |
| Settings storage                    | `<CONTENT_ROOT>/.fsbrain/auth.json` (owner-only `0600`, atomic writes). No secrets — a trust domain, public keys/locations, rules.                           |

Access levels: `read` (GET only) < `readwrite` (everything except auth
settings) < `admin`. `defaultAccess` applies to any verified identity in the
trust domain that matches no rule; set it to `none` for allowlist-only vaults.
Rules match `exact` ids or `prefix` subtrees (e.g.
`spiffe://example.org/readonly/`); exact beats prefix, longer prefixes beat
shorter ones. Settings changes apply **immediately** (checked per request) —
no restart.

## Identity option A — JWT-SVIDs without any infrastructure

You don't need SPIRE to start. A SPIFFE identity is just a signed statement;
any keypair whose public half the hub trusts (its JWKS) works, and you can
upgrade to SPIRE later **without touching the vault** — the contract (a
JWT-SVID with a `spiffe://` subject) is identical.

Mint a keypair + tokens with Node and [jose](https://github.com/panva/jose)
(already a dependency of `apps/api`):

```js
// mint.mjs — node mint.mjs > token.jwt   (writes bundle.jwks.json on first run)
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';
import { readFile, writeFile } from 'node:fs/promises';

const SUB = 'spiffe://example.org/agent/laptop-a';
let keys;
try {
  keys = JSON.parse(await readFile('signing-key.json', 'utf8'));
} catch {
  const pair = await generateKeyPair('ES256', { extractable: true });
  keys = { private: await exportJWK(pair.privateKey), public: await exportJWK(pair.publicKey) };
  keys.public.alg = 'ES256';
  keys.public.kid = 'k1';
  await writeFile('signing-key.json', JSON.stringify(keys));
  await writeFile('bundle.jwks.json', JSON.stringify({ keys: [keys.public] }));
}
const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
  .setSubject(SUB)
  .setAudience('fsbrain')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(await importJWK(keys.private, 'ES256'));
console.log(token);
```

Copy `bundle.jwks.json` to the hub (the `jwks.file` setting above — or paste
it as `inline` in the settings dialog), and give each agent machine a cron/
script that rewrites its token file hourly. Keep the signing key somewhere
safe; anyone holding it can mint identities in your trust domain.

## Identity option B — SPIRE (the real thing)

With [SPIRE](https://spiffe.io/docs/latest/spire-about/) you get attested,
auto-rotating identities and never handle a signing key yourself:

1. Run a **SPIRE server** (one per trust domain) and a **SPIRE agent** on each
   machine that hosts an fsbrain agent (join-token attestation is fine for
   VMs/laptops).
2. Register each workload, e.g.
   `spire-server entry create -spiffeID spiffe://example.org/agent/laptop-a …`
3. On each agent machine, have [spiffe-helper](https://github.com/spiffe/spiffe-helper)
   (or `spire-agent api fetch jwt -audience fsbrain`) write the JWT-SVID to a
   file on a timer. Point the MCP server at it (below) — rotation is picked up
   automatically via the file's mtime.
4. On the hub, either sync the trust bundle to a file (`jwks.file`) or run
   SPIRE's OIDC Discovery Provider and set `jwks.url` to its keys endpoint.

One trust domain can span all your networks — SPIRE agents dial out to the
server, so no federation is needed until a second organization is involved.

## Identity option C — mTLS X.509-SVIDs

For certificate-based identity (and/or TLS termination in the API itself),
start the hub with:

```bash
FSBRAIN_TLS_CERT=/etc/fsbrain/server.pem \
FSBRAIN_TLS_KEY=/etc/fsbrain/server.key \
FSBRAIN_TLS_CLIENT_CA=/etc/fsbrain/agents-ca.pem \
npm run dev:api
```

Clients presenting a certificate that verifies against `agents-ca.pem` and
carries a `URI:spiffe://…` SAN in the trust domain are authenticated by that
identity — no bearer token needed. Certless clients still fall through to
bearer auth, so both modes coexist. All three PEM files are watched and
hot-reloaded on rotation. (Terminating TLS in a reverse proxy instead? Keep
using bearer tokens — client-cert passthrough is proxy-specific and not
required.)

## Connecting an agent

On each agent machine, run the stdio MCP server in proxied mode with
credentials:

```bash
API_BASE_URL=https://vault.example.com \
FSBRAIN_API_TOKEN_FILE=/run/spiffe/svid.jwt \   # rotating JWT-SVID (preferred)
fsbrain-mcp

# or, for quick experiments:
API_BASE_URL=https://vault.example.com FSBRAIN_API_TOKEN=$(node mint.mjs) fsbrain-mcp

# optional client TLS (X.509-SVID identity and/or a private server CA):
FSBRAIN_CLIENT_TLS_CERT=/run/spiffe/svid.pem \
FSBRAIN_CLIENT_TLS_KEY=/run/spiffe/svid.key \
FSBRAIN_CLIENT_TLS_CA=/etc/fsbrain/hub-ca.pem \
API_BASE_URL=https://vault.example.com fsbrain-mcp
```

`FSBRAIN_API_TOKEN_FILE` is re-read whenever the file changes, so rotation
needs no restart. The `MCP_ACTOR` header still exists but is ignored by an
auth-enabled hub for remote requests — attribution comes from the verified
identity.

## API reference

- `GET /api/auth` — status. Loopback/admin callers also get the full rule
  list; every caller gets `caller: { kind, spiffeId?, access? }` ("who am I").
- `PUT /api/auth` — partial update (only provided fields change). Loopback or
  `admin` only.
- `POST /api/auth/test` — `{ "token": "…" }` → `{ valid, spiffeId?, access?,
reason? }`. Dry run; grants nothing.

Denial codes: `unauthorized` (no credential), `invalid_token` (signature/
expiry/audience), `not_spiffe_subject`, `wrong_trust_domain`,
`not_authorized` (verified, no access), `read_only`, `admin_required`,
`local_only` (auth settings from remote while disabled), and
`auth_misconfigured` (503 — the hub's JWKS can't be loaded).

## Operational notes

- **Reverse proxy on the hub machine:** proxied requests arrive from
  127.0.0.1, which the loopback exemption would wave through. Set
  `allowLoopback: false` — and add an `admin` rule for yourself first. The
  API never trusts `X-Forwarded-For`.
- **Lockout recovery:** loopback with `allowLoopback` on, an `admin` SVID, or
  — the last resort — edit/delete `<CONTENT_ROOT>/.fsbrain/auth.json` on the
  hub's disk and restart nothing (settings are read per request).
- **What this is not:** rate limiting, request quotas, or DoS protection —
  put a reverse proxy in front for those. And remember the review queue is
  still your write-gate of last resort: agents can be given `readwrite` yet
  still be steered to `propose_edit` workflows.
