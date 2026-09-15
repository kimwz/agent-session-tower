# Using Agent Session Tower

## Start

Install Node.js 22.13 or later, npm, and Git. Install and sign in to Claude Code, Codex, or both on the machine whose sessions you want to view. Their commands must be available on `PATH` to start or continue work from Tower.

```sh
npx --yes github:kimwz/agent-session-tower
```

This installs from GitHub and builds the web UI on the first run. No npm registry release is required. The server opens your browser at http://localhost:8000. Keep the terminal running; press `Ctrl+C` to stop.

To install the command for regular use:

```sh
npm install --global github:kimwz/agent-session-tower
agent-session-tower
```

The examples below use that installed command. You can also replace it with `npx --yes github:kimwz/agent-session-tower`.

## CLI options

```sh
agent-session-tower doctor
agent-session-tower --port 8001
agent-session-tower --no-open
agent-session-tower --state-dir /path/to/tower-state
agent-session-tower --help
```

`doctor` checks for the provider commands and reports the session directories. The default port is `8000`; the default bind address is `127.0.0.1`.

## The canvas

Projects group sessions by their working folder. Open a session node to read its conversation. Subagents are grouped with their parent; independently forked sessions remain separate.

Use **새 세션** (New session) to choose a provider, existing absolute folder path, optional title, and first request. A project's **+** button preselects its folder. Rename or pin a project from its header, and select manual layout to drag projects and session cards. Layout preferences are stored in that browser; custom names, project pins, and hidden sessions are stored on the server.

Search and provider, time, and status filters narrow the graph. Blue **새 활동** (New activity) indicators mark unread conversation updates. **세션 종료** hides a session and its children; it does not stop their work or delete native history. Hidden sessions can be reopened from **종료한 세션**.

## Existing sessions and new work

Tower reads native history directly from:

- `~/.claude/projects/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

Custom `CLAUDE_CONFIG_DIR` and `CODEX_HOME` locations are supported. Tower does not import or copy CLI authentication files.

Status combines native lifecycle events, live process signals, and recent log activity. Some CLI versions provide fewer signals, so a status may be inferred; the UI's status explanation distinguishes this. macOS is the verified platform. Linux has not been verified. Windows is not currently supported.

Sending a request continues the same native session. Claude sessions resume through the CLI. Codex sessions use the existing local app server when available, or resume through the CLI when the session is no longer owned by another writer. Busy sessions queue requests; unavailable app-server connections may leave them waiting until the original session is released. Tower runs up to two requests at once, with one active request per session.

Subagent records without an independently resumable session ID are viewable through their parent. Existing terminals or desktop apps may need a refresh or resume to show changes made from the web. Required approvals for work sent through the Codex app remain in that app. Tower does not automatically bypass provider permissions. CLI-resumed Codex work uses `workspace-write`; Claude work uses `acceptEdits`. Usage is billed through the existing provider account.

You can upload up to 10 attachments per request: 10 MB per file, 5 MB per image, and 20 MB total. PNG, JPEG, GIF, and WebP images use native image input; other files are provided as local copies. Uploaded files remain on the host so the conversation can keep referencing them.

## Remote access

Stop the existing server before changing its bind address:

```sh
agent-session-tower --host 0.0.0.0 --port 8000
```

The terminal prints reachable interface addresses, the username `monitor`, and the password-file path. By default, read the generated password with:

```sh
cat ~/.agent-monitor/access-password
```

Enter those credentials in the browser's login prompt. The password persists across restarts. With `--state-dir`, use the password file in that directory instead. To listen on one interface, use `--host <the-machine's-IPv4-address>`.

The client device must be able to reach the host and port. A firewall, NAT, or VPN may require network configuration; Tower does not create a tunnel or public URL. Direct access uses HTTP Basic authentication over HTTP, which does not encrypt credentials or conversations. Use a trusted LAN or VPN. Custom domains and HTTPS reverse-proxy configuration are not built-in features. The host machine and Tower must stay running.

## Stored settings

The default state directory is `~/.agent-monitor/`, retained for compatibility with earlier local builds. `--state-dir` overrides it. It contains generated access credentials, managed request history, custom titles, project pins, hidden-session settings, and uploaded attachments. State directories use private permissions; the access password file is mode `0600`.

Only one Tower server may use a state directory at a time. Launching it again opens the existing server. Avoid running separate state directories that control the same native session concurrently.

Stopping Tower does not automatically replay interrupted requests on restart. Hiding a session, clearing a failed-request notification, or renaming a session does not delete its original Claude Code or Codex history.
