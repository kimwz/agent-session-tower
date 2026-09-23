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

A Node HTTP process serves the API and built React UI. A separate detached execution worker owns provider connections, queued work, approvals, Auto Prompt routing, and terminal shells. The web process reconnects through an authenticated owner-only local socket; stopping the web process does not stop work. Server-sent events update the browser. No database or hosted backend is required. The graph uses React Flow.

### Browser workspace

Project editor/terminal controls open a resizable workspace overlay on the same authenticated page, to the left of chat when it is open. The minimum width is 420px, limited by the viewport; screens without enough horizontal space stack workspace above chat. Direct `/?workspace=<absolute-directory>&tool=editor|terminal` URLs remain available. CodeMirror edits UTF-8 files up to 2 MiB, with revision checks and atomic saves; the explorer lists up to 2,000 entries per directory and skips symbolic links. xterm.js connects to an interactive `node-pty` shell through authenticated SSE and token-protected input/resize requests. Each terminal tab owns its own shell (up to eight per workspace). Closing a tab stops its shell; hiding the panel keeps shells running. Active shells survive web disconnects and restarts; only an explicit tab close or shell exit ends them. The browser tab remembers the terminal tabs and their IDs for reconnecting. Exited terminal records are cleaned up after 30 seconds.

`node-pty` uses native bindings. Platforms without a matching prebuild need a C++ build toolchain and Python during dependency installation. Standalone builds embed the matching bindings and extract them into a private temporary directory when the first terminal starts. The PTY smoke test uses `/bin/sh` with an isolated HOME and never launches a native agent provider.

## Releasing

1. Write the `## [x.y.z] - YYYY-MM-DD` section in `CHANGELOG.md`, dated the day you release.
2. Run `npm version x.y.z`. It runs `npm run check`, refuses to continue without that changelog section dated today, syncs the version the app reports, commits `Release x.y.z` (see `.npmrc`), tags `vx.y.z`, and rebuilds so the built app reports the new version.
3. `git push --follow-tags`. The Release workflow publishes the changelog section as the GitHub release notes.

A specific release can be run with `npx --yes github:kimwz/agent-session-tower#vx.y.z`.


### Web restart and execution worker

Restart the web PID only. Its shutdown closes HTTP streams and authentication sessions, but never sends provider cancellation or termination. The worker owns `runs.json`, `created-sessions.json`, and `auto-prompts.json`; only one worker may write them. Its separate lock is in `<state-dir>/runner-runtime/`. Local RPC uses a short Unix socket in an owner-only `/tmp/tower-runner-<uid>-<hash>/` directory plus a private random credential. This worker transport currently targets POSIX systems.

After the web server stops, running and queued work and approval waits remain live. Restarting with the same state directory reattaches without resubmitting prompts. Mutating RPC requests are not retried after uncertain transport failures. An incompatible worker is never replaced while handling work. The worker exits only after at least 30 seconds without a web client and with no active runs, routing jobs, or terminal shells. An idle restart therefore picks up a new worker build; active work keeps its existing engine until it finishes. While the attached worker runs a different build from the web page, the header shows **Worker update pending**; features added since that build, such as reasoning effort, do not apply until the worker is replaced. Slack monitoring keeps the worker active, so turn it off before an idle restart.

The first upgrade from an older in-process runner needs a handoff or a fully drained old server: its old SIGTERM handler still cancels work. Do not start a new worker against the same state files while the old runner is writing them. Test with fixtures; never kill the old process merely to test restart behavior.
