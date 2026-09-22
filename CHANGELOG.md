# Changelog

Every release has a section here; it is published as that version's GitHub release notes.
Versions follow [Semantic Versioning](https://semver.org): the CLI options, the state directory
format, and saved browser preferences are the compatibility surface.

## [1.5.0] - 2026-09-22

### Added
- Dedicated Slack mention conversations with the ordinary session chat composer, follow-up instructions, and scoped tools for Auto Prompt delegation, task results, reading the original thread, and posting replies.
- Automatic continuation of the Slack conversation when a delegated task finishes, with durable request keys for task dispatch, result notifications, and reply delivery.

### Changed
- Slack monitor now shows five compact mention cards, newest first, with five more per expansion. Dedicated Slack conversations stay out of the ordinary session list and project canvas.
- Slack coordinator turns retain Auto approval review on both creation and resume. Existing processing records keep their previous behavior and are not replayed.

## [1.4.0] - 2026-09-22

### Added
- An opt-in Slack setting to process your own mentions for testing saved instructions, including in accessible private channels. The setting persists across restarts and leaves bot messages and message edits excluded.

## [1.3.0] - 2026-09-22

### Added
- A draggable Slack monitor on the canvas when an account is connected, with a saved position in both automatic and manual layouts and individual mention cards.
- Rainbow activity borders for active Slack work, connection status, and a mention detail panel showing the matching decision, Auto Prompt route, agent conversation, and reply delivery result.

## [1.2.0] - 2026-09-22

### Added
- Slack personal-account automation: monitor direct mentions, match configurable instructions, execute through Auto Prompt, and reply in the original thread after completion. Includes an inline setup guide, processing history, durable event deduplication, and guarded reply delivery.
- Workspace file browsing and editing, plus persistent interactive terminals in a resizable workspace panel.
- Local account management and authenticated remote access with persistent login-attempt history and IP blocking.

### Changed
- Agent execution, approvals, Auto Prompt routing, and terminal shells run in an independent worker and survive web-server restarts.
- Slack Codex tasks always request Auto approval review. Explicit approval settings use a new session when existing-session settings cannot be verified; Codex must confirm Auto before a task is submitted.
- Deployment completion now requires synchronized versions, release notes, a commit and release tag pushed to the configured remote, and verification of the running version.

### Fixed
- Improved approval interactions, workspace layout, and standalone executable packaging for the editor and terminal runtime.

## [1.1.0] - 2026-09-18

### Added
- Choose who reviews Codex approval requests when creating a session: Codex's own default, its automatic reviewer ("Approve for me"), or always asking you. Tower used to start every Codex session asking you, even when your own Codex sessions use auto review. The same control appears in Auto Prompt, where it applies only when a new Codex session is created; an existing session keeps the reviewer stored with its thread. The choice is remembered in the browser, and the sandbox itself is unchanged.
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
