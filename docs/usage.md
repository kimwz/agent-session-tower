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

Choose **한국어 / English** in the top bar to switch the interface language. The first visit follows your browser language, and your choice is remembered in that browser. Conversation text, session titles, and folder paths stay as written.

Use **새 세션** (New session) to choose a provider, existing absolute folder path, optional title, and first request. A project's **+** button preselects its folder. Rename or pin a project from its header, and select manual layout to drag projects and session cards. Layout preferences are stored in that browser; custom names, project pins, and hidden sessions are stored on the server.

Search and provider, time, and status filters narrow the graph. Blue **새 활동** (New activity) indicators mark unread conversation updates. **세션 종료** hides a session and its children; it does not stop their work or delete native history. Hidden sessions can be reopened from **종료한 세션**.

## Existing sessions and new work

Tower reads native history directly from:

- `~/.claude/projects/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

Custom `CLAUDE_CONFIG_DIR` and `CODEX_HOME` locations are supported. CLI credentials stay on the host machine. Account usage uses native Codex account APIs and the existing Claude Code OAuth credential; credentials are not sent to the browser or copied into Tower's state directory.

Status combines native lifecycle events, live process signals, and recent log activity. Some CLI versions provide fewer signals, so a status may be inferred; the UI's status explanation distinguishes this. macOS and Linux (with systemd for the background service) are verified; the test suite runs on both. Windows is not currently supported.

Sending a request continues the same native session. Claude sessions resume through the CLI. Codex sessions use the existing local app server when available, or an app-server process started by Tower when the session is no longer owned by another writer. Busy sessions queue requests; unavailable app-server connections may leave them waiting until the original session is released. Tower keeps one active request per session; independent sessions can run concurrently.

Subagent records without an independently resumable session ID are viewable through their parent. Existing terminals or desktop apps may need a refresh or resume to show changes made from the web. Claude Code does not list sessions started from Tower in its `claude --resume` picker; use the terminal button in the chat header to copy a command that resumes the session by ID in its project folder. Usage is billed through the existing provider account.

### Tool approvals

For task execution, Tower leaves the native permission and sandbox configuration in effect. For example, a Claude Code `auto` default stays `auto`. Tower does not force `acceptEdits`, disable approval prompts, or set Codex approvals to `never` for the session receiving your work. The separate Auto Prompt router runs with execution tools disabled so it can only select a destination.

New Codex sessions use Codex's default approval reviewer, which asks you, unless **자동 검토 (Approve for me)** is chosen under **승인 검토** in the New Session or Auto Prompt dialog (Auto Prompt applies it only when it creates a new session); that lets Codex's own reviewer agent judge sandbox escalations while the sandbox itself stays as configured. The choice is stored with the Codex thread, so it also applies to later requests in that session and can be changed in Codex itself; setting `approvals_reviewer = "auto_review"` in `~/.codex/config.toml` instead makes it the default for every Codex client.

When a Tower-launched session needs permission, the chat shows the requested tool and its input with **Allow once** and **Deny** buttons. Codex can also request additional filesystem or network access for the current turn; those requests show **Allow for this turn** and the requested access. Neither decision saves a permission rule or changes your global settings. The execution stays open while waiting. Canceling the run or stopping Tower clears its pending approvals, and an expired request cannot be approved later.

Codex approvals from verified child agents appear in the parent conversation with the requesting agent's name. Each pending request is answered separately; a child approval or child completion does not end the parent task. Requests from unrelated conversations or finished turns cannot be approved.

Codex questions show their choices and, when allowed, a text input. MCP connector requests can show a form or a link to an external flow. Complete the requested fields or follow the link yourself, then submit or decline the request. Tower supports the standard MCP form fields: text, numbers, booleans, and single or multiple selections. Unsupported form schemas remain visible for inspection and can be declined or canceled, but cannot be submitted. These controls do not automatically choose answers, open external links, or grant persistent permissions.

For work sent to an already open Codex desktop session, its original app continues to handle approvals. Check that app when it is waiting for permission. Explicit provider deny rules still apply.

You can upload up to 10 attachments per request: 10 MB per file, 5 MB per image, and 20 MB total. PNG, JPEG, GIF, and WebP images use native image input; other files are provided as local copies. Uploaded files remain on the host so the conversation can keep referencing them.

## Auto Prompt

Use the sparkle button in the upper-right corner of a machine or project box to open **Auto Prompt**. The machine button selects **Auto**; a project button selects that folder. On the canvas, **Shift+P** also opens it with **Auto** selected, regardless of the Korean or English keyboard layout. The shortcut does not interrupt text entry or another dialog, and reopening an unresolved request preserves its destination.

Choose a folder on the left and the **Claude** or **Codex** icon on the right. The selected icon is colored; the other is gray. Then enter a request. File attachments, image paste, drag and drop, and **Ctrl/Cmd+Enter** work as in chat. Plain Enter inserts a newline.

With **Auto**, a separate routing agent first chooses from Tower's known project folders, then considers sessions in that folder. Selecting a folder skips the first step. The router uses **Claude Opus** or **GPT-5.6-Sol** through your existing native sign-in. Routing consumes provider usage in addition to the eventual task. It does not change the model of the session receiving your request.

The router considers session titles, recent conversation, pending requests, and available context usage. It prefers the same session for a continuation. A new subject normally starts a new session; an idle session with useful project context can also be reused when its known context usage is **30% or less**. This percentage is context used, not account quota. When a native record does not supply the context window size, Tower does not assume that it is below 30%. Hidden sessions and subagents are excluded, and the chosen provider and folder are enforced.

The dialog shows the routing stage, chosen folder and session, and the reason. **Open conversation** takes you to the actual task. Existing busy sessions receive continuations through the normal queue. You can cancel while the router is deciding; once the request has been sent, use the conversation's normal stop control. Closing the dialog does not cancel the request.

Tower validates the selection again before sending the original prompt and attachments. If the destination changed, the model returned an invalid choice, or a folder could not be determined, it reports the problem without submitting elsewhere. Retrying an uncertain connection uses the same request ID. Interrupted routing requests are not automatically replayed after a server restart.

See [Auto Prompt architecture and API](auto-prompt.md) for integration details.

## Account usage

The machine node shows separate usage indicators for the Claude Code and Codex accounts connected on that machine. Percentages represent **used capacity**, not remaining capacity. These are account-wide limits, so activity on other devices can count toward them.

Hover, focus, or select an indicator to see the available usage windows, such as five hours and one week, and their reset times. Not every provider, plan, or authentication method supplies the same windows. Missing data is shown as unavailable, and older data is marked stale instead of being displayed as a fresh zero.

## Model selection

The chat composer lets you choose a model for the next request. **Agent default** sends no model override and follows the native agent or session configuration. An explicit selection is saved with the request, so queued requests and retries keep their chosen model.

Codex models come from the native model catalog. Claude Code supports its native model aliases. Existing session models can also appear in the selector. Changing the selection does not interrupt the current turn; it applies when the next request runs. In an open Codex app session, an explicit choice updates that session's native model setting before the request is queued. Another client changing the same session's model settings can affect queued turns.

## Remote access

Stop the existing server before changing its bind address:

```sh
agent-session-tower --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000` on the server computer. Expand the navigation and select the **Account management** icon at the upper right to set an ID and a password (12–256 characters). Direct localhost access requires no login. Other devices see a login page; remote access stays unavailable until an account is configured. With `--state-dir`, the account and security records belong to that state directory.

Use the network address printed in the terminal from your other device and sign in with the configured ID/password. Passwords are stored only as salted scrypt hashes. Login sessions last up to 12 hours and end on logout, password change, IP block, or server restart. Ending a session also disconnects its live event and terminal-output streams.

Account management is available only through a direct localhost connection. It shows the latest 1,000 successful, failed, and blocked login attempts, with timestamps, entered IDs, and connection IPs. Local access without login does not create a login attempt.

Five cumulative failed logins from the same IP permanently block that IP. A successful login does not reset the count, and restarting Tower does not remove the block. In **Blocked IPs**, select **Unblock** to remove the block and reset its failure count. Devices sharing a network's public IP also share this limit. The fifth failed attempt is shown as **Blocked** because it activates the block.

`--host 0.0.0.0` permits both localhost administration and network access. To listen on only one nonloopback interface, configure the account first, then restart with `--host <the-machine's-IPv4-address>`. That mode does not listen on localhost; to change credentials, inspect history, or unblock an IP, stop Tower and restart on `127.0.0.1` or `0.0.0.0` with the same state directory.

The client device must be able to reach the host and port. Tower does not create a tunnel or public URL. Direct access uses HTTP, which does not encrypt passwords or conversations; use an encrypted VPN or a separately secured HTTPS deployment. The host machine and Tower must stay running.

Reverse-proxy configuration is not a built-in feature. Tower identifies clients by the socket address and does not trust forwarded IP values. Proxied clients therefore share the proxy's IP for blocking. Never expose Tower through a localhost proxy that rewrites the Host header to localhost and omits forwarding headers: such requests are indistinguishable from direct local administration. A proxy must preserve an explicitly allowed public Host and send forwarding headers so local bypass is disabled; public origins currently require server integration rather than a CLI option.

Earlier versions generated a plaintext `access-password` file and used HTTP Basic authentication. That credential is no longer accepted or loaded. Set an account locally after upgrading. An existing legacy file is left untouched; it may be removed after confirming the new account works.

## Stored settings

The default state directory is `~/.agent-monitor/`, retained for compatibility with earlier local builds. `--state-dir` overrides it. It contains account credentials, login security records, managed request history, custom titles, project pins, hidden-session settings, and uploaded attachments. `auth.json` stores the ID, salt, scrypt parameters, and password hash; `auth-security.json` stores login history, failure counts, and blocked IPs. These files use mode `0600`, and the state directory uses mode `0700`. Session cookies are not persisted on the server.

Only one Tower server may use a state directory at a time. Launching it again opens the existing server. Avoid running separate state directories that control the same native session concurrently.

Stopping or restarting the Tower web server leaves accepted agent work running in a separate local execution process. Restart with the same state directory to reconnect to output, approvals, and queued requests. Use the task’s Stop action to cancel it. If the execution process itself crashes or the machine restarts, uncertain requests are not automatically replayed. Hiding a session, clearing a failed-request notification, or renaming a session does not delete its original Claude Code or Codex history.
