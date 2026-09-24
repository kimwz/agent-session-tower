# Changelog

Every release has a section here; it is published as that version's GitHub release notes.
Versions follow [Semantic Versioning](https://semver.org): the CLI options, the state directory
format, and saved browser preferences are the compatibility surface.

## [1.22.0] - 2026-09-24

### Added
- **Groundwork for using this Tower from your other computers.** Coming releases let one Tower show and control the sessions of your other computers. This release adds what keeps that safe; nothing you see changes yet.
  - Each computer keeps a list of folders it never shares with another computer. Folders below them and conversations started there are left out too. If the list cannot be read, every folder stays private until it can. The panel for editing the list comes in the next release.
  - Work another computer sends is marked as coming from that computer. When Tower picks the folder for it, an excluded folder is never chosen. It never reaches a Slack or GitHub coordinator conversation, and Tower tools are not attached to it. A request sent again after a lost connection runs only once.

### Changed
- When a request is refused because the execution worker is being replaced, the error now says it was not accepted, so it is safe to send again.

## [1.21.0] - 2026-09-24

### Added
- **Branch sync on the canvas.** A project folder that is a git repository shows how many commits its branch is behind (↓) or ahead of (↑) its upstream. Tower fetches pinned folders and folders used in the last week every five minutes, without touching `FETCH_HEAD`, the index lock or credentials prompts. Open the badge to see the details and to pull (fast-forward only) or push (to the tracked branch, never forced).
- **Up to date before work starts.** When you start a session or send a request, Tower first fast-forwards the folder's branch if that cannot lose anything: the branch is only behind, no tracked file has uncommitted changes, and no agent is working in the folder. The badge says when it did. Diverged branches and uncommitted work are left for you or an agent to resolve.
- **Shared ground rules for every agent.** On start, Tower adds a marked section to the global `~/.claude/CLAUDE.md` (importing `~/.agent-monitor/agent-guidance.md`) and `~/.codex/AGENTS.md` (or `AGENTS.override.md` when that is in use): fetch and fast-forward before changing a repository, work in a separate worktree when another agent shares the folder and remove it afterwards, and never leave commits unpushed without saying so. A new installation sets this up by itself. Everything outside the section stays as it is, symbolic links to a dotfiles repository are followed, providers that are not set up get nothing, and a file containing `<!-- agent-session-tower:off -->` is left alone.

## [1.20.1] - 2026-09-24

### Changed
- **Adding a trigger starts with what kind it is.** **Add trigger** first asks for the kind (scheduled run, GitHub issues, HTTP response or Slack mentions), each with a line on what it does, so GitHub triggers no longer hide behind a dropdown inside the form. With no triggers yet, the same choice is shown straight away.
- The trigger editor is laid out in numbered steps: what to watch, how often to check (for GitHub and HTTP), and what to do. For GitHub, running a task per issue or handing issues to the coordinator is a visible choice. Approvals, overlap, the hourly limit and the other rarely changed options sit under **Advanced**, whose heading summarizes their current values.
- The trigger window has **Connections** (Slack, the GitHub login check, API keys and tokens, and internal addresses HTTP triggers may call) and **Limits** tabs in place of one mixed settings tab. The list shows each trigger's kind as an icon, and **History** labels changes in your language without repeating what the name and label already say.

## [1.20.0] - 2026-09-24

### Added
- **GitHub coordinator.** A GitHub trigger can hand each new issue to a coordinator instead of a single task. Like Slack's, it reads the issue and its comments, follows the first of your rules that applies, hands the work to a project agent, and proposes comments. Nothing is posted until you approve: click a proposal above the conversation, or say so in the chat (for example “send reply 2 to GitHub”, or ask it to post the result when the work is done). A rule with **automatic reply** posts one result comment by itself, as you set it up.
- Proposals appear above the coordinator's conversation, reached from the trigger monitor. Before posting, Tower checks again that GitHub still acts as the trigger's account. A comment that surely did not go out can be approved again; one that may have arrived is never posted twice.

### Changed
- Agents can keep a rule's automatic reply as you set it, but cannot turn one on or change a rule that has one. When an agent restores an earlier revision or a deleted trigger, automatic replies you had turned off stay off, and the history says so.
- With **approve myself**, the coordinator's delegated work waits for your approval in Tower; the setting a conversation began with is kept even if the trigger changes later.

## [1.19.1] - 2026-09-24

### Changed
- The Slack conversation coordinator (rules, delegated work, reply proposals and your send approvals) no longer assumes Slack, so the next release can use it for GitHub issues. Slack conversations work exactly as before.

## [1.19.0] - 2026-09-24

### Added
- **GitHub triggers.** A trigger can watch GitHub for issues newly opened in chosen repositories, or for open issues newly assigned to you, and start a run for each one in a new session. The issue goes to the agent as reference material, never as instructions; Tower tools are not attached. Issues that already exist when a trigger is set up do not start runs, and issues opened while Tower was off are found at the next check.
- Sign in with the GitHub CLI login on this computer (`gh auth login`) or a token saved as a secret for `https://api.github.com`. **Check connection** shows the account; the trigger keeps to it and stops checking with a visible error if the login becomes another account. By default only issues from the repository's owners, members and collaborators count; labels and authors narrow it further.
- **Run now** on a GitHub trigger checks GitHub at once and runs what is new.

### Changed
- GitHub's rate limit is respected: when it is used up, every trigger using that sign-in waits until it resets. A check that cannot read everything since the last one changes nothing and is tried again later; if more than 300 issues arrived in between, the trigger says so and asks to be turned off and on rather than skip some quietly.

## [1.18.0] - 2026-09-24

### Changed
- **Trigger monitor.** The Slack monitor on the canvas is now the trigger monitor: one lane with Slack mentions and trigger runs together, newest first. It appears once Slack is connected or any trigger exists, and stays where you left the Slack monitor. A run card shows whether it is waiting, working, done or failed; finished runs you have not opened are marked unread, while runs that finished before this update start out read.
- Opening a run shows when and why it ran, the instructions it was given, the response an HTTP trigger saw, any error, and the latest messages of the session that did the work. It stays open and current even after newer runs push it down or its trigger is deleted. The lane header opens a list of recent runs next to the Slack overview, and older runs load as you ask for more.

## [1.17.0] - 2026-09-24

### Added
- **HTTP triggers.** A trigger can now check a URL on a schedule with GET or POST (headers, body and a timeout) and start a run when the response changes, when a condition becomes true (a value picked with a JSON Pointer equals, contains, exceeds, and so on), or on every successful response. The first response only sets the starting point. The run starts in a new session and gets the response as reference material, never as instructions; Tower tools are not attached. **Test request** in the editor shows the response and whether the condition holds, without recording anything.
- **Header secrets.** API keys and similar header values are saved in the trigger panel's settings for one address (origin). They are sent only to that address, only by triggers you gave them to, and a response that echoes one back has it removed. Agents never see the values, cannot give a secret to a trigger, and cannot change a request that sends one.
- HTTP triggers can call this computer or a private network only at addresses you list in settings, and never Tower itself or cloud metadata addresses. Redirects are checked again, and requests ignore proxy settings in the environment.

### Changed
- A POST that may have reached the server is never sent again for the same time, even after a restart, and an agent's retry of a manual run does not resend it. Failing requests wait longer each time, up to half an hour, and the trigger shows the error. All HTTP triggers together send at most 60 requests a minute.

## [1.16.0] - 2026-09-24

### Added
- **Agents can manage triggers.** When you send a message from Tower, the agent gets Tower tools for that turn: it can list sessions, runs and project folders, hand work to Auto Prompt, and create, change, run, turn off, delete or restore triggers. Changes apply immediately, appear in trigger history with the session and turn that made them, and can be undone. A retried call never applies the same change twice.
- The tools are not given to turns forwarded to the open Codex app, to conversations that contain Slack or other outside content, or to work that triggers, Slack or agents started. The chat says so under a turn that runs without them. Trigger limits stay yours to change.

### Changed
- Slack conversation tools now use a credential that belongs to that conversation instead of the execution worker's own.

## [1.15.0] - 2026-09-24

### Added
- **Triggers.** The lightning button in the header replaces the Slack button. The trigger panel lists Slack and your scheduled runs, with history and limits in their own tabs. Slack settings open from the Slack row, as before.
- **Scheduled runs.** Run instructions on a cron schedule (minute hour day month weekday, with a time zone) or at a fixed interval, and send them to Auto Prompt, a new session in a chosen folder, or an existing session. Runs approve automatically by default (Codex auto review, Claude auto mode) or wait for your approval in Tower. You choose what happens if the previous run is still working (skip, keep one waiting, or run in parallel), and a trigger pauses itself if it runs more often than its hourly limit. After the computer sleeps, the latest missed time runs once, within a day. A time that does not exist on a daylight-saving day is skipped.
- Trigger history shows each run and every change, including who made it. Content changes can be undone, and deleted triggers can be restored for a while. Turning a trigger off also stops runs it already fired that have not started.
- Sessions a trigger created leave the canvas once their work is done; their history stays in the session list.

### Changed
- Slack and trigger work together run at most three turns at a time by default; the rest wait. Your own requests are never held back. The limit is in the trigger panel's settings.

## [1.14.0] - 2026-09-24

### Added
- Deploying a new version now updates the execution worker by itself. When the web server starts next to a worker from an older build, it asks that worker to hand over. The worker keeps serving, including Slack, until a moment when nothing is running, then starts the new worker and exits. Running turns, approval requests and shells are never interrupted; the header shows **Worker update pending** until the switch. A request that arrives during the switch is refused with a message and can be sent again. The first switch from a worker older than this release still needs the old worker to finish and be replaced manually.

### Changed
- Terminal shells now run in their own background process instead of the execution worker, so updating the worker never closes them. Shells opened before this release keep working until you close them.

## [1.13.4] - 2026-09-23

### Changed
- Tower now records who started each task: you in Tower, Slack automation, or (in coming releases) triggers and agents. Conversations that Slack content entered stay marked, including sessions created before this release when Slack records still link them. This prepares the upcoming triggers; it does not change how you work.
- A queued instruction can be inserted into a running turn only when both were started the same way. For example, an automatic Slack result can no longer be inserted into a turn you started.

### Fixed
- Slack send approval in Tower chat is now granted only by a message you send yourself. It no longer depends on an internal request ID, so work Tower or an agent submits can never count as your approval. With an execution worker older than this release, Tower refuses such work instead of passing it on as yours.

## [1.13.3] - 2026-09-23

### Fixed
- In manual layout, a folder stays where you dragged it even when none of its sessions are shown. Previously, once its cards left the view (for example past the 24-hour cutoff), the folder was drawn around those hidden cards and moved whenever one of them was removed. It now stays where it was last shown, and existing saved layouts keep their current positions.
- New sessions in a manually arranged folder now appear one below another, starting at the top of an empty folder. Hidden cards from older sessions used to take those slots and pushed new cards far away. An older hidden card now gives up its slot and is placed below its folder when it is shown again. Hidden cards of newer sessions, such as recent sessions hidden by a search, still keep their slots.

## [1.13.2] - 2026-09-23

### Fixed
- Codex conversations that generate images no longer fail with "Codex emitted an oversized protocol message." Codex sends each finished image inline, about 2.5 MB for one image, which exceeded Tower's 2 MB limit per message and ended the request just as the image was done. Tower now accepts messages up to 64 MB and reads large ones without rescanning them.

## [1.13.1] - 2026-09-23

### Fixed
- Codex runs that another agent started (`codex exec`, `codex review`) no longer appear as your own sessions on the canvas, in the session list, or as Auto Prompt targets. This no longer depends on how the command was written: wrappers, scripts, and prompts read from files are all recognized.
- When such a run starts inside an agent's turn, Tower now connects it to that agent from the running process tree, so it appears in that session's subagent view. This also applies to `claude -p` runs started inside a turn. A run that cannot be connected stays out of view.

## [1.13.0] - 2026-09-23

### Changed
- Pages receive only what changed. Tower no longer resends the session list when nothing changed, and an open page now receives just the sessions, runs, or settings that changed instead of the whole snapshot. With about 1,100 sessions that snapshot is about 1.5 MB, and it used to be resent every few seconds even while idle. Pages opened before this release keep working and receive complete snapshots, now only when something changes.
- The web server no longer scans Claude Code and Codex histories itself. The execution worker already scans them and now also serves conversation history. While an older worker is still attached, the web server keeps its own scan until that worker is replaced.
- The execution worker saves streamed output to its task history every 2 seconds instead of up to five times a second, and no longer rewrites state files that did not change. Status changes are still saved immediately.

## [1.12.3] - 2026-09-23

### Fixed
- Show the context usage ring for Claude sessions on 1M-context model variants such as `opus[1m]`. Claude Code reports their capacity under a key like `claude-opus-5-5[1m]`, which Tower did not match to the model in the transcript, so those sessions showed an empty ring.
- Estimate context usage for `claude-opus-5-5` from its 1,000,000-token default while a turn is still running.

## [1.12.2] - 2026-09-23

### Fixed
- The chat composer keeps the session's last requested reasoning effort after a page reload instead of showing the default. The next message is sent with that effort again.

### Added
- The header shows **Worker update pending** while requests run on an older execution worker than the page. Features added since that worker started, such as reasoning effort and Slack auto-replies, do not apply until it is replaced; the tooltip explains how.

## [1.12.1] - 2026-09-23

### Changed
- Reorganize Slack automation settings into **Rules**, **Connection**, and **Activity** tabs. Rules appear as compact rows with an on/off switch, agent and model, and auto-reply badges; one rule opens for editing at a time. Only the content scrolls, and a save bar with Discard stays visible while you have unsaved changes. Instruction fields grow with their text, activity shows the newest 20 first, and deleting a rule asks for confirmation.

## [1.12.0] - 2026-09-23

### Added
- Slack rules can opt in to **Auto-reply with the result without approval**. When the coordinator delegates work under such a rule, Tower lets it send one truthful result reply, including failures, following the rule's reply guidance. Saying “do not send” in Tower chat still cancels it.
- The Slack coordinator can add and remove emoji on the original request, for example ⏳ while working and ✅ after replying, while reply permission exists. This needs the `reactions:write` user scope.

### Changed
- Slack replies can mention people who wrote in the thread, including you, with `<@USER_ID>`. Other mentions and broadcasts stay escaped, and Tower ignores its own replies so self-mention testing cannot loop.

## [1.11.2] - 2026-09-23

### Fixed
- Recognize delegated Codex reviews launched through an absolute executable path, including commands followed by status reporting or cleanup. Existing matching review sessions now join their parent family and completed Slack tasks disappear from the canvas.

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
