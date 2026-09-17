# Development

## Run from source

Node.js 22.13+, npm, and Git are required. macOS is the verified platform.

```sh
git clone https://github.com/kimwz/agent-session-tower.git
cd agent-session-tower
npm ci
npm start
```

`npm ci` installs dependencies and builds the server and web UI through the `prepare` script. `npm start` opens the browser at http://localhost:8000.

```sh
npm run dev
npm run build
```

`dev` runs the TypeScript server and serves the built UI without opening a browser. Rebuild after editing the client.

## Check changes

```sh
npm run check
```

This runs TypeScript checks, the test suite, and a production build. Tests use temporary session records and test processes; HTTP tests open local loopback ports.

### Keep live checks out of personal session history

A temporary working directory does not isolate native session storage. Codex writes conversations under `CODEX_HOME` (normally `~/.codex`), and Claude Code uses its configuration directory. Tower discovers those records, including conversations created by a smoke test.

Run live native checks with a separately authenticated test configuration directory outside the directories monitored by your regular Tower instance. Use `isolatedSmokeEnv` from `scripts/native-smoke-env.ts` and pass its result as the native process environment. It requires `TOWER_SMOKE_CODEX_HOME` or `TOWER_SMOKE_CLAUDE_HOME` and refuses shared session storage. The local approval smoke harnesses use this guard before starting a provider. Do not copy personal credentials or symlink personal session directories into a test home. Keep the Tower state directory and working directory separate as well.

Use nonpersistent execution when the native interface supports it, but verify that child agents also remain isolated. A temporary working directory or an ephemeral parent alone is not proof that descendants cannot write session records.

If a check has already created personal history, use **Close session** in Tower to hide the specific test conversation. This preserves its native history and allows reopening it from **Closed sessions**. Do not hide all temporary paths: users may intentionally work in them.

## Package

```sh
npm pack
```

The package includes the CLI, compiled server, web assets, documentation, and license. Git installs run `prepare` before packaging, so the GitHub repository can be used directly with `npx` without committing build output. `npm pack` does not publish to the npm registry.

## Standalone executable

Building a standalone executable requires **Node.js 26+**. It produces a binary for the current operating system and architecture, with the Node runtime, server, and web assets included.

```sh
npm run build:executable
npm run test:executable
./artifacts/agent-session-tower
```

Running the resulting executable does not require a separate Node.js installation. Claude Code or Codex must still be installed and signed in to create or continue work. The macOS build receives an ad hoc signature; it is not notarized. The build also writes a SHA-256 checksum.

If the builder cannot locate the Node.js license beside the installed runtime, set `AGENT_MONITOR_NODE_LICENSE` to that license file. The legacy variable name is retained for compatibility. Embedded third-party notices are served at `/THIRD_PARTY_NOTICES.txt`.

## Source map

| Path | Purpose |
| --- | --- |
| `bin/` | CLI entry point |
| `server/` | Native session discovery, process status, local API, and queued CLI work |
| `client/` | React UI and graph canvas |
| `shared/` | Shared data contracts and session logic |
| `tests/` | Parser, state, UI logic, runner, and HTTP tests |
| `scripts/` | Standalone executable build and smoke test |

One Node HTTP server serves the API and built React UI. Server-sent events update the browser. No database or external backend is required. The graph uses React Flow.
