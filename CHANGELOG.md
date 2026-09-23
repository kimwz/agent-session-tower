# Changelog

Every release has a section here; it is published as that version's GitHub release notes.
Versions follow [Semantic Versioning](https://semver.org): the CLI options, the state directory
format, and saved browser preferences are the compatibility surface.

## [1.11.1] - 2026-09-23

### Changed
- Show the effective default reasoning effort, such as “Default effort (Medium)”, from Claude Code’s effort setting or Codex’s configured effort, falling back to the model’s own default. Codex’s configured model is shown as its default model.

### Fixed
- Stop reconnected workspace terminals from typing replies such as `1;2c` into the shell when replayed output contains an old terminal query.

## [1.11.0] - 2026-09-23

### Added
- Choose the reasoning effort next to the model in chat. Claude Code offers low through max; Codex lists the levels and default each model advertises, and the choice is hidden for models without effort control.
- Choose the model and reasoning effort when starting a new session or sending an Auto Prompt.
- Open several terminals per workspace as tabs. Tabs survive page reloads and reconnect to their shells; closing a tab stops only that shell.

## [1.10.2] - 2026-09-23

### Fixed
- Recover parent relationships for background Codex reviews that redirect output to a file and append an exit-status marker.
- Treat background tool acknowledgements as launch receipts rather than execution completion, allowing existing review sessions to join their parent family and cleanup.

## [1.10.1] - 2026-09-23

### Fixed
- Recognize Codex review sessions launched by Claude agents from matching execution records, keeping their worktrees in the parent session family instead of separate canvas projects.
- Include proven cross-provider descendants in completed Slack task cleanup while preserving active work and native history.

## [1.10.0] - 2026-09-23

### Changed
- Honor owner chat requests to compose and send Slack replies without requiring a proposal click or exact wording, including requests made while delegated work is running.
- Persist one-time completion-report permission while keeping initial event processing, rules, and task results unable to authorize sending by themselves.

### Fixed
- Always create fresh sessions for Slack-delegated work and preserve the matched rule’s project instructions when choosing its working folder.

## [1.9.2] - 2026-09-23

### Added
- Collapse or expand Slack reply proposals to leave more space for conversation while keeping the proposal count visible.

## [1.9.1] - 2026-09-23

### Fixed
- Ensure writing-style collection controls have visible borders, button backgrounds, and keyboard focus styling in the monitor panel.

## [1.9.0] - 2026-09-23

### Added
- Distinguish unread completed Slack threads and successfully sent replies with monitor card borders; opening a thread marks its current result as read.
- Collect a bounded sample of your own Slack messages to create an editable tone guide for reply proposals.

## [1.8.6] - 2026-09-23

### Fixed
- Make Slack coordinator responses follow Tower’s language preference, including background mentions and follow-up turns in existing conversations.

## [1.8.5] - 2026-09-22

### Fixed
- Delegate project goals and explicit user constraints without injecting Slack reply policy or prescribing coordinator-generated execution steps; project agents plan from their own local context.

## [1.8.4] - 2026-09-22

### Fixed
- Honor explicit owner instructions to send an exact Slack reply after a specific delegated task succeeds, preserving approval across restart without asking again.
- Require task outcome verification before consuming conditional approval; failed or uncertain work cannot send a success reply.

## [1.8.3] - 2026-09-22

### Changed
- Make Slack reply suggestions directly clickable with compact hover and keyboard focus styling, removing separate approval buttons.

## [1.8.2] - 2026-09-22

### Fixed
- Give Slack reply approval actions a filled button appearance with clear hover, keyboard focus, and disabled states.

## [1.8.1] - 2026-09-22

### Fixed
- Honor explicit owner approval in Slack coordinator chat, including sending a numbered saved proposal or approving a previously selected proposal. Automatic messages and proposal tools cannot grant consent.
- Clarify reply approval controls and retain the original owner message alongside delivery results.

## [1.8.0] - 2026-09-22

### Added
- Automatically remove completed Slack-created delegated work sessions and their finished subagents from the canvas, preserving session history and active or reused user sessions.

## [1.7.0] - 2026-09-22

### Added
- Per-instruction Slack model selection using the connected agent’s available models, applied to coordinator conversations and delegated task execution. Existing instructions can keep the agent default.

## [1.6.0] - 2026-09-22

### Changed
- Slack agents now present numbered reply proposals in Tower chat. Reply guides only inform drafting; automatic Slack replies are disabled for both new conversations and legacy workflows.
- Sending requires explicit user approval of the exact proposal in Tower, with durable duplicate-send and uncertain-delivery protection.

## [1.5.2] - 2026-09-22

### Fixed
- Keep projects under `/tmp` and `/private/tmp` off the canvas in both layout modes, while preserving their session history and sidebar access.

## [1.5.1] - 2026-09-22

### Fixed
- Use the same Slack icon for the top navigation settings button and the Slack monitor.

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
