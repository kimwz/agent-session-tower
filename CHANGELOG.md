# Changelog

Every release has a section here; it is published as that version's GitHub release notes.
Versions follow [Semantic Versioning](https://semver.org): the CLI options, the state directory
format, and saved browser preferences are the compatibility surface.

## [1.1.0] - 2026-09-18

### Added
- Choose who reviews Codex approval requests when creating a session: Codex's own default, its automatic reviewer ("Approve for me"), or always asking you. The choice is remembered in the browser, applies to Auto Prompt's new Codex sessions, and is stored with the Codex thread.
- Copy a ready-to-paste terminal command that continues the open session in Claude Code or Codex, from the chat header or the session details. It changes to the session's project folder first so the agent keeps working there.

### Notes
- Claude Code leaves sessions started from Tower out of its `claude --resume` picker because they run in print mode; they remain resumable by ID, which is what the copied command uses. Codex lists Tower-started sessions normally.

## [1.0.0] - 2026-09-17

First stable release.

### Added
- Discover local Claude Code and Codex sessions, including ones started outside Tower, and follow them on a live project graph with working, waiting, completed, and error states.
- Create sessions, continue conversations with attachments, choose a model per request, and send a queued request into the active turn.
- Approve tools, answer questions, and complete connector forms from chat, including requests from Codex child agents.
- Auto Prompt routes a request to a suitable existing session or starts a new one.
- Rename sessions and project groups, pin and hide projects, arrange the canvas manually, filter, search, and track unread activity.
- Claude Code and Codex account usage inside the machine node.
- Password-protected remote access over LAN or VPN.
- New session folders are created when missing and trusted for the chosen CLI before it starts.
- Adjustable chat panel width and text size.

### Changed
- Server and client sources are grouped by feature, the stylesheet is split by screen area with an explicit cascade order, and unused styles were removed. No behavior change.

## [0.1.0]

Development preview.
