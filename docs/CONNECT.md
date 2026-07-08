# Connect your agent to the fsbrain vault

This doc gets an MCP-aware agent host (OpenClaw, Claude Desktop, Claude Code,
Cursor, …) talking to your local markdown vault through the **self-contained**
`fsbrain-mcp` server.

The server is one stdio process. It starts the storage API in-process, auto-
creates `CONTENT_ROOT` (default `~/.fsbrain/vault`), and exposes 26 vault
tools. Every agent write is recorded in `<vault>/.fsbrain/audit.jsonl` and
attributed via `X-Actor` (default `agent:mcp`, overridable with `MCP_ACTOR`).

---

## Quickstart (5 lines)

```bash
git clone https://github.com/andylow92/file-system-like-github.git
cd file-system-like-github
npm install
npm run build            # produces apps/mcp/dist/server.js (the bin)
npm run start:agent      # launches fsbrain-mcp on stdio (Ctrl-C to stop)
```

The server prints a readiness banner on stderr, e.g.:

```
fsbrain-mcp ready · mode=embedded · vault=/home/me/.fsbrain/vault · tools=26 · actor=agent:mcp
```

Then point your agent host at it — copy one of the snippets below.

> **Tip.** `CONTENT_ROOT=/path/to/my/vault npm run start:agent` overrides
> the default vault location. The path is auto-created. Run `npm run doctor`
> any time to check that Node is recent enough and the vault is writable.

---

## Hosts

All four hosts spawn the server as a stdio child process and forward env
vars you specify in their config. Use the **absolute path** to
`apps/mcp/dist/server.js` for `node`-based snippets (run `pwd` in the repo
root and append `/apps/mcp/dist/server.js`).

### OpenClaw

Edit `~/.openclaw/openclaw.json` and add the `mcp.servers.fsbrain-vault`
block (key is nested `mcp.servers`, not flat `mcpServers`):

```json
{
  "mcp": {
    "servers": {
      "fsbrain-vault": {
        "command": "node",
        "args": ["/ABS/PATH/TO/file-system-like-github/apps/mcp/dist/server.js"],
        "env": {
          "CONTENT_ROOT": "/ABS/PATH/TO/your/vault",
          "MCP_ACTOR": "agent:openclaw"
        }
      }
    }
  }
}
```

Or use the CLI (each `--arg`/`--env` is repeatable):

```bash
openclaw mcp add fsbrain-vault \
  --command node \
  --arg /ABS/PATH/TO/file-system-like-github/apps/mcp/dist/server.js \
  --env CONTENT_ROOT=/ABS/PATH/TO/your/vault \
  --env MCP_ACTOR=agent:openclaw
```

> **Schema note.** The OpenClaw schema is documented at
> <https://docs.openclaw.ai/cli/mcp>. If your installed `openclaw` rejects
> this form, run `openclaw mcp --help` to see the local CLI's exact flag
> names and check the docs page for any breaking changes.

### Claude Desktop

Edit `claude_desktop_config.json` (location is host-OS dependent — see the
[MCP local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fsbrain-vault": {
      "command": "node",
      "args": ["/ABS/PATH/TO/file-system-like-github/apps/mcp/dist/server.js"],
      "env": {
        "CONTENT_ROOT": "/ABS/PATH/TO/your/vault",
        "MCP_ACTOR": "agent:claude-desktop"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

### Claude Code (CLI)

Add the server with `claude mcp add` (the `--` separates `claude`'s flags
from the spawn command). `-e` is repeatable:

```bash
claude mcp add fsbrain-vault \
  --scope user \
  -e CONTENT_ROOT=/ABS/PATH/TO/your/vault \
  -e MCP_ACTOR=agent:claude-code \
  -- node /ABS/PATH/TO/file-system-like-github/apps/mcp/dist/server.js
```

`--scope project` writes a `.mcp.json` in the current project (committable).
Omit `--scope` for the local default. See
<https://code.claude.com/docs/en/mcp>.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project
(project-scoped). The shape matches Claude Desktop:

```json
{
  "mcpServers": {
    "fsbrain-vault": {
      "command": "node",
      "args": ["/ABS/PATH/TO/file-system-like-github/apps/mcp/dist/server.js"],
      "env": {
        "CONTENT_ROOT": "/ABS/PATH/TO/your/vault",
        "MCP_ACTOR": "agent:cursor"
      }
    }
  }
}
```

Reload Cursor (or use the Settings → MCP UI). See
<https://docs.cursor.com/context/model-context-protocol>.

---

## Running without a build

If you can't run `npm run build` (no esbuild for some reason), launch the
TypeScript entry directly with `tsx`:

```bash
npx tsx /ABS/PATH/TO/file-system-like-github/apps/mcp/src/server.ts
```

In a host config, that's:

```json
{
  "command": "npx",
  "args": ["tsx", "/ABS/PATH/TO/file-system-like-github/apps/mcp/src/server.ts"]
}
```

The bundled bin is preferred (one process, no per-launch JIT cost), but the
`tsx` form is the same code behind the same MCP surface.

---

## Environment variables the server reads

| Var            | Default              | Purpose                                                |
| -------------- | -------------------- | ------------------------------------------------------ |
| `CONTENT_ROOT` | `~/.fsbrain/vault`   | Vault directory; auto-created if missing.              |
| `MCP_ACTOR`    | `agent:mcp`          | Label recorded on every write (Activity feed + audit). |
| `API_BASE_URL` | _(unset)_            | If set, proxy this URL instead of starting the API.    |
| `PORT`         | _(ephemeral)_        | Port for the in-process API. Use `0` or omit for any.  |
| `HOST`         | `127.0.0.1` in embed | Bind address for the in-process API.                   |

---

## Verifying the connection

After your host loads the server, ask the agent:

1. **List my notes.** It should call `list_notes` and show `welcome.md` (on
   a fresh vault).
2. **Create a note `today.md` saying "hello from <host>".** It will call
   `create_note`.
3. **Show recent activity.** It will call `recent_activity` and you'll see
   the create attributed to the actor you configured.

You can also tail the audit log directly:

```bash
tail -f "$CONTENT_ROOT/.fsbrain/audit.jsonl"
```

If the agent reports an MCP/connection error, check the host's MCP log for
the readiness banner (`fsbrain-mcp ready · …`). No banner means the spawn
failed — usually a bad absolute path or a missing `node`/`npx` on the host's
`PATH`. Run `npm run doctor` from the repo root for a fast preflight.
