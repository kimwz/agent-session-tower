# Changelog

Every release has a section here; it is published as that version's GitHub release notes.
Versions follow [Semantic Versioning](https://semver.org): the CLI options, the state directory
format, and saved browser preferences are the compatibility surface.

## [1.117.0] - 2026-10-08

### Changed
- **Clear eligible session backlogs in bounded consecutive batches.** When maintenance confirms cold records and leaves candidates deferred by its time or session budget, the next batch starts one second after completion rather than waiting an hour. Batches retain the existing 30-second start budget and 100-session limit, share in-flight checks, and drain without cancelling work during worker handoff. No-progress and incomplete checks keep the hourly interval.
- Fresh retention observations resolve logical Git projects only for user parents, avoiding repeated Git processes for one-shot child and helper workspaces. Parent project proofs are still refreshed on every observation, and native ownership, file identity, writer reservations and activity protections remain unchanged.
- Maintenance resumes at the next candidate after a time limit and at the first processable candidate deferred by the session limit, so failures near the front do not repeatedly starve later candidates. Oversized families stay deferred. Native originals, history databases and cold backups remain recoverable; this does not physically delete native history or reclaim its disk space.

## [1.116.1] - 2026-10-08

### Fixed
- The context ring on the chat header's icon is thinner and no longer cut off at its top, bottom and sides.

## [1.116.0] - 2026-10-08

### Changed

- **The permission reviewer reads the scripts it judges, and the ones they start.** A one-shot run of a wrapper (`node scripts/run-all.mjs`) used to go to the owner because the reviewer, which had no tools, saw only the script named in the command and not the child it spawns. The reviewer now gets three read-only tools that Tower itself serves (`read_file`, `list_dir`, `search_text`) and follows what the command runs until it knows the effects: writes and deletes, processes it starts or signals, network calls, and reads of personal data or credentials. It approves what the owner's task covers, including routine steps such as tests, fixtures, builds and local commits, and it never runs anything.
- The tools read only the request folder's repository and its worktrees, the folders the command changes into, and the files the command or the files already read name: paths, relative imports and spawns (also unquoted shell words, `cd`, `bash child`), local Python packages, and a script's own folder. Credential files and stores (`.env`, `.envrc`, `.dev.vars`, keys, Terraform state, service-account JSON, `.git/config`, `~/.ssh`, `~/.config/gh`, `~/.cloudflared`, the Claude and Codex sign-ins …), files named like credentials or kept in folders named `secrets`/`credentials`, and Tower's state (except its skills) are refused everywhere, also in what Tower reads ahead for the reviewer; source code named so (`auth.ts`, `server/secrets/*.ts`) stays readable. Text inside files is treated as data: a script that asks the reviewer to approve it changes nothing.
- When the reviewer leaves a request to the owner, the reason names the concrete risk or what could not be confirmed, and which files Tower refused, could not find or could not open.
- A run the reviewer allowed starts only while what its decision rests on is as reviewed: the files read and where their names lead, the entries of the folders they sit in, and the folders where the modules they use would be found. A changed script, a link pointed elsewhere, or a new file that could change what runs (a `lib.js`, a `package.json`, a package's `__init__.py`) sends the run back to the reviewer with the current contents, as does a change while the reviewer reads. An approval whose run had to wait more than a minute is reviewed again first. After three returns for changed files the owner decides. Shared temporary folders such as `/tmp` are not bound by their entries, only the files read there. The owner's own approvals are not affected.
- Claude stopping a review with its safeguards now fails that review with that reason (the owner decides), instead of an unknown-event error.

## [1.115.0] - 2026-10-08

### Added
- **Compact a conversation into a new session.** A compact button sits left of the archive button in an open chat. It has the new **Session compaction** model role (Settings › Models, `sessions.compactor`; Claude Haiku 5.5 by its pinned ID `claude-haiku-5-5`) read the conversation's whole history without tools or a saved session, sub-sessions excluded, and keep what the work needs: the goal, where it stands, open work, the owner's standing preferences, approvals, refusals and stops, decisions with their reasons, files, commits, pull requests and links, and next steps. A conversation larger than one call is summarized part by part and merged in order; its beginning is never dropped. Tower then opens one new session in the same folder and on the same computer with the provider, model and reasoning effort the original's latest answer ran with (from its native record, else Tower's last request, else the CLI default; never the new-chat defaults). The summary reaches the new session as Tower's hidden instructions on its first message, so later turns keep it, and that first turn only takes the work over and waits for the owner. The page moves to the new session when it is ready; the original stays as it is, and its header links to the continuation.
- A compaction is refused while the conversation works or has queued or scheduled requests, and is abandoned (nothing created) when the conversation changes before the session is created, when it is cancelled, or when the model call fails. A second click, a retried request or a worker handoff returns the same new session (a new one only when that session can no longer carry the work); compacting a compacted session again reads the summary it started with from its own first message. A joined computer's conversation is compacted on that computer under its sharing rules, and agents and the master cannot start or cancel one. An ordinary worker update waits for a compaction; **Update now** does not start new ones and stops one still reading or summarizing.

### Changed
- **The chat header shows context usage like the canvas.** The top-left icon is the round provider orb with the conversation's context ring; unknown usage shows only the track.
- Sessions report the reasoning effort their latest answer ran with (Claude answers, Codex turn context), and controllers receive it.
- The `haiku` model choice is labelled Haiku 5.5 and offers reasoning levels, as Claude Code 2.1.293 selects claude-haiku-5-5 for it.

## [1.114.2] - 2026-10-08

### Changed
- **The master reads with Eleven v4 Turbo without tone tags.** Eleven v4 acts `[cheerfully]` and `[excited]` out too strongly, so Tower no longer puts them in front of first replies, answers, news, read-again answers or voice samples on that model. Brackets the master writes are still read as words. v3 and v3 conversational keep their tone tags, and flash v2.5 is unchanged. An answer being read when the reading model changes is read to its end with the model it started with, so a part written with a tag never reaches Eleven v4; the new model applies from the next answer, or from sentences written after the change.

## [1.114.1] - 2026-10-08

### Changed

- Show active project connections as flowing rainbow dashed lines using the session activity border palette. Idle and stale connections, reduced motion and the canvas motion setting keep their existing appearance.

## [1.114.0] - 2026-10-07

### Changed

- Move eligible inactive helper and subagent records out of ordinary native/Tower session discovery after an explicit retention archive request or seven days from their verified last task. Completed existing children use that last-task date; active, waiting, scheduled and coordinator work remain protected. Claude children also remain protected while an ancestor can resume them.
- Apply the existing limit of 20 recent parent sessions per logical project to native cold storage after its migration grace, preserving active families and allowing original restoration.
- Use an unloaded independent Codex maintenance server for native archive/unarchive and preserve Codex original records and history databases. Keep Claude original files in permanent private cold storage with per-member recovery records, conflict detection and no-overwrite restoration. Managed cold records are excluded before normal transcript parsing; cold storage preserves originals, so disk savings are measured separately from list and parsing reductions. JSONL exports remain transcript copies rather than portable backups of complete Codex history.
- Fix fixture teardown paths that recreated or left temporary directories, track exact runner siblings without recreating them, and await owned MCP configuration release after consumers exit. Collect stale Tower-owned temporary data conservatively with process/path inspection and worker-handoff draining. Legacy cleanup is limited to proven fixture patterns that are empty and at least 48 hours old; shared runner directories, nonempty unproven folders and active consumers remain untouched.

## [1.113.0] - 2026-10-07

### Added
- **Every turn has browser tools.** Tower gives every Claude and Codex turn it starts two browsers, and names them in the turn's Tower instructions so agents use them for web pages before computer use:
  - `browser_light` for pages a project serves (localhost, preview deployments, UI checks and screenshots): a fresh headless browser each turn, with no logins.
  - `browser` for outside sites: the installed Google Chrome (Playwright's Chromium otherwise) running headless without the switches and the user agent that mark an automated browser, so ordinary bot checks see a regular Chrome. Logins made there are kept in `<state-dir>/browser/logins.json` (owner-only): after each tool call and when the browser closes, the cookies and the local storage of the open pages are saved. Each turn adds only what it changed, so turns running at the same time do not undo each other's logins. The file stays under 30 origins of local storage and 4 MB by dropping what was used least recently; a file that cannot be read is set aside and reported, and the browser starts without it.
  - A strong browser for sites that block those: Aside when its CLI (`aside`) is installed, for Claude and Codex turns; otherwise Claude in Chrome for Claude turns when its extension is set up (`--chrome`). Every other Claude turn starts with `--no-chrome`.
- Agents choose a browser from the uses each one lists; nothing asks for approval. When a site needs a login they look for the credentials in Tower's vault or ask the owner, and they never try to solve CAPTCHAs.
- Each turn's browser closes when the turn ends, and `browser_close` saves the logins, closes it and lets the next call start a new one; the logins are also saved when the agent's own code closes the browser. A browser left behind by a tool server that was killed outright is ended by the next one to start; only browsers carrying Tower's own marker are touched. Snapshots and screenshots go to an owner-only folder in the system temporary directory, kept for a week, never into the project.
- A browser tool server loads Playwright only when the agent first uses it, so a turn that never browses costs about 60 MB per server.

### Safety limits
- A conversation that holds outside content (Slack, GitHub issues, public agents) gets both browsers without the saved logins, cannot reach this computer's own addresses (localhost) through them, redirects included, and is not offered `browser_run_code_unsafe`; it never gets the owner's own browser. Right after such a blocked address, the next navigation or two may be interrupted by the browser's error page.
- Local storage is read from the pages open after each tool call: a site left within the same call right after logging in keeps only its cookies.
- Tower installs no browser. A computer with neither Google Chrome nor Playwright's Chromium reports how to install one (`npx playwright install chromium`; on Linux also `sudo npx playwright install-deps chromium`).
- The standalone executable has no browser tools. Aside is wired as its documented `aside mcp` server but was not tried, as it is not installed here.

## [1.112.0] - 2026-10-07

### Added
- **Settings show session retention decisions and separate cold backups.** The worker observes a seven-day expiry for finished child sessions and a limit of 20 parent sessions per logical project, protecting active, queued and scheduled work, approvals, unread results and active descendants. Existing records receive seven days of migration grace; closing a session still only hides it.
- Eligible inactive sessions can be manually backed up to verified compressed bundles, read without restoring native history, and exported or imported through a separate directory in a registered workspace. These bundles are not included in Tower's existing settings backup.
- Managed agent instructions direct one-off reviews and investigations to Claude's `--no-session-persistence` and Codex's `--ephemeral` execution options, with their results recorded in the parent task.

### Safety limits
- **Automatic native removal and native restore remain unavailable.** Neither installed provider exposes the verified writer reservation needed to preserve running work and a complete backup while removing records. Candidates remain `blocked-provider`, no duplicate backup is made automatically, and the present reduction in native files and scan load is zero. Manual backups retain their originals and use additional disk space.

## [1.111.0] - 2026-10-07

### Added
- **Images, video and audio open in the workspace pane.** A conversation path or a file in the workspace file tree that names a png, jpg, gif, webp, avif or bmp image is shown fitted to the pane; mp4, m4v, webm, mov or ogv video and mp3, m4a, aac, wav, ogg, oga, opus or flac audio play in the browser's own player, with seeking. Files on joined computers play the same way once those computers run this version. Large files stream by byte range instead of loading whole, so seeking works and phones such as iPhone play video. A file the browser cannot decode, or one that is missing or not shared, names itself with the reason and a retry button. Text files still open in the editor, and other binary files keep the editor's refusal.
- `GET /api/workspace/media?cwd=&path=` serves those files inside the same folder boundary as the text editor (folders listed in Tower, no symbolic links, the joined computer's sharing list).

### Fixed
- On a joined computer, a download that a sharing change cut off no longer keeps the next download or playback from being cut off by a later sharing change.
- A download from a joined computer that is cancelled while its file is being opened now closes the file. Before, the file stayed open, and Node.js 26 could stop the Tower that served it when it later cleaned up the file.

## [1.110.0] - 2026-10-07

### Changed
- **The master reads aloud with ElevenLabs Eleven v4 Turbo.** It is the new default and the first choice in the master's settings under **읽어 주기 모델** ("v4 터보 (빠름, 추천)"). ElevenLabs offers Eleven v4 through Text to Dialogue, so Tower asks for it there, as one line in the chosen voice. Answers are still made part by part as finite 128 kbps mp3, so stopping, listening again, the first reply, the daily limit and removing what ElevenLabs keeps in its history work as before. Each part keeps its one bright or excited tone at the start, and it is counted at v3 conversational's price. v3 conversational, v3 and flash v2.5 remain available and are asked for as before; a model chosen earlier stays chosen.
- Tower 1.109.2 and older cannot read master settings that name Eleven v4 Turbo: they start the master with its default settings and without its session, and saving settings there replaces the file. Restoring a backup that names it on such a version leaves out the master's settings and ElevenLabs key. Choose another reading model before going back to such a version.

## [1.109.2] - 2026-10-07

### Fixed
- **Auto Prompt no longer blocks the execution worker while collecting candidate sessions.** Each routing snapshot now reads Slack coordinator session IDs once instead of rebuilding and copying the workflow and run lists for every native session. Direct requests for a new session also avoid this repeated work, and the worker remains available to serve session lists and history during submission.

## [1.109.1] - 2026-10-06

### Fixed
- **Auto Prompt routes with Claude Code 2.1.290 again.** That version opens every routing run with a notice that plugin screens should redraw (`system/ui_invalidate`). Auto Prompt refused it as an unknown event, so every Claude routing request — including tasks Slack and trigger workflows delegate — failed with "unsupported routing event (system/ui_invalidate)". The notice runs nothing and adds nothing the model reads, so routing now accepts it; malformed versions of it and other plugin screen events are still refused.

## [1.109.0] - 2026-10-05

### Changed
- **Attachments keep their originals on the execution computer.** Chat and Auto Prompt upload files in resumable chunks and send file references with the instruction. The new upload path has no fixed file or combined size limit; up to 10 files can be attached, subject to available disk space, filesystem and network limits. Small supported images still use native image input; larger images and other files are supplied as local originals.
- Original downloads stream from disk, including downloads from joined computers larger than the previous 64 MiB response cap. Accepted files remain available to their conversations; unfinished uploads and unsubmitted originals expire after 24 hours.
- File cleanup follows the execution worker's durable admissions and drains before worker handoff or shutdown. Existing bounded JSON attachments and saved chat references supported by an older worker remain compatible while an update waits for active work to finish.

## [1.108.1] - 2026-10-04

### Fixed
- **Settings on a phone show their whole menu again.** On screens up to 680 px wide the settings list no longer cuts off rows such as **모델**, **알림** and **백업** when the screen is short; the list scrolls instead. The **설정** title stays on one line, the close button sits at the right end of the header, and the list no longer scrolls sideways.

## [1.108.0] - 2026-10-04

### Added
- **File paths in a conversation open in the workspace editor.** When an agent names a file by its absolute path, as a Markdown link (`[script](/Users/me/video/script.md)`), in inline code or in plain text, clicking it opens the file in the browser workspace editor on the same page, with the file selected in the tree, instead of opening a broken address in a new tab. Agents keep writing plain paths; only the page reads them. A path opens when it lies in a folder Tower lists on the conversation's own computer, and a joined computer's conversation opens only that computer's folders; other paths stay as written, and a link to one explains why it does not open. Names with spaces and Hangul work in links and inline code. The editor's limits are unchanged: a file that cannot be opened, such as a binary file, one over 2 MiB or one that no longer exists, is named with the reason, and **다시 시도** opens it again. Clicking the file that is already open reloads it unless it has unsaved edits, and opening another file still asks before discarding edits.

### Fixed
- Opening a folder as a file in the workspace editor says that only regular text files can be opened, instead of reporting that the file changed while opening it.

## [1.107.0] - 2026-10-03

### Changed
- **The secret vault stays open through Tower updates.** Once unlocked, the vault no longer locks again each time Tower updates, is deployed, switches with **지금 업데이트** or applies a restore: the previous execution worker hands the open vault to the next one directly, over a private pipe, so it is never written to disk or placed in a command line or environment. The vault still locks when you lock it, after a restart of the computer, and when Tower's execution worker stopped without handing over, which happens when Tower's web server has been gone for a while with no work running. Restarting only the web server while the worker keeps running leaves it open. A handed-over key that does not open the vault on disk (for example after restoring another vault) is ignored and the vault stays locked. Secrets connected to a conversation on this computer stay connected until it is archived, as before; connections for conversations on other computers still end after 8 hours.

## [1.106.2] - 2026-10-03

### Fixed
- **State files Tower cannot read are kept, not overwritten.** When trigger state, legacy trigger secrets, session tasks, skill state or the master's follow state cannot be read or moved aside, Tower keeps the original file and locks that store (session tasks keep summarizing in memory only) instead of saving over it, and the related panel shows a warning. Public-agent data that cannot be read stops the start instead; conversations of the wrong shape that cannot be moved aside are kept and close that agent until Tower restarts. Corrupt model settings are copied aside byte for byte and reported in **Settings → Model**. The encrypted Vault keeps failing closed as before.
- **An update hold or helper lock that cannot be read keeps holding.** Worker handoffs, restores and **지금 업데이트** wait instead of treating it as released, and a missing hold no longer removes one written in the meantime.
- An idle worker no longer shuts down while a handoff is under way.
- On Linux with Node.js 24 or later, a running Claude Code session is no longer shown as stopped: its process, which Linux lists as `MainThread`, is recognized again.
- The skill advisor stays still while its store is locked: it reads no history, calls no model and changes no counters, and a failed background pass is logged instead of left unhandled.
- Claude master replies record when they were written, as Codex replies already did.
- Unexpected errors in the insert-or-wait judgment are logged.
- The model settings warning wraps long recovery paths on narrow screens.

### Changed
- Display stores, Auto Prompt state, the Vault, pending secret imports and the worker handoff record are saved through one private atomic writer with exclusive temporary files. A failed save reports its first error, and the handoff file contents are synced before the handoff goes ahead.
- Backups, run scheduling and handoff, trigger state and once consumption, and master voice records, audio and reading each have a single owner. Domain errors carry a kind; HTTP status codes, bodies, audio and event streams are set only at the HTTP edges, with the same responses as before. The local terminal event stream now sends `Cache-Control: no-store`, like the worker and terminal-host relays.
- The trigger editor takes its interval limits and defaults from the same definitions the server checks.

## [1.106.1] - 2026-10-03

### Fixed
- **Image links open when followed from another site.** Opening a conversation image link from another app or page, from a Tower page at another address, or after signing in again to a login in front of Tower such as Cloudflare Access showed "다른 사이트에서의 접근은 허용되지 않습니다." The link now opens the image for the signed-in owner. Other sites still cannot embed or read images or call Tower's API, and tampered links are still refused.

## [1.106.0] - 2026-10-03

### Added
- Explicit once reservations that are consumed only once and archived automatically, with retained run/audit history and a separate archived trigger list.
- Revision-checked archive management and durable consumption records across restart, deletion and backup restore.

### Changed
- Preserve local archive choices and recovery grants during backup restore, rejecting restores that exceed final merged capacity.
- Reviews and native checks use the computer's existing Claude/Codex CLI login by default; nonpersistent execution and test data separation no longer require a new authenticated profile.

## [1.105.1] - 2026-10-03

### Fixed
- Permission reviews inspect directly referenced local scripts and input files instead of relying on shortened conversation excerpts. Absolute-path and interpreter rules receive contextual review and can return to the agent as exact one-time execution requests.
- Permission reviews honor the owner's explicit task scope for authorized work outside the project, publication and deployment, and request one-time execution when Codex cannot use a conversation-only rule.
- Reviews retry when referenced script contents change while the model is deciding. Recognized authentication, secret and environment-value stdin is excluded from model evidence.

## [1.105.0] - 2026-10-03

### Changed
- List secret names, references and permitted operations while the vault is locked, from a plaintext index (no values or keys) of its last unlocked state. Discovering keys no longer makes agents ask for an unlock.
- Turn the use of a secret while the vault is locked into a clear request: the agent asks the owner to unlock it, naming the secret it needs, and retries after they confirm.


## [1.104.3] - 2026-10-02

### Fixed
- Avoid WebKit's reproduced unknown-length MP3 startup stall by completing each bounded TTS part before sending its independent audio with an exact Content-Length. Keep playback during the native turn, reply order, final residual flush, cancellation and replay with per-part acknowledgements.
- Require meaningful media-clock progress before marking voice playback as started or completed. Preserve bounded recovery for an initially stalled answer without shortening the watchdog or interrupting healthy playback.
- Preserve accepted playback-start evidence immediately when a streamed turn is cancelled before its first acknowledgement, so an already heard turn does not trigger an extra cancellation-error reading.

## [1.104.2] - 2026-10-02

### Fixed
- Discover secrets only when the current task needs credentials, without adding a vault guide to unrelated agent turns.
- Send private connection notices only after the owner explicitly assigns a key through the chat input. Keep vault state, saved-key edits, automatic project connections and expiry silent, while preserving broker authorization and targeted remote delivery.

## [1.104.1] - 2026-10-02

### Fixed
- Preserve bounded master voice wait, retry and play-attempt history instead of overwriting the evidence with later progress. Record terminal ACK receipt independently of diagnostic request ordering.
- Correlate TTS queue/start/first-byte/completion and host/web audio request delivery measurements with the same run and say, without recording speech or changing playback policy.

## [1.104.0] - 2026-10-02

### Added
- Give owner agents private instructions to discover available Tower secrets before asking for credentials, and map permitted references to consumer environment variables.
- Notify active owner turns privately when secret connections, values, permissions or source availability change. Coalesce notices, defer them during approvals, and keep them out of Tower chat without starting idle sessions or changing broker authorization.

## [1.103.2] - 2026-10-02

### Fixed
- Preserve playback diagnostics across the web-to-master RPC boundary instead of dropping the page's media state.
- Record bounded live audio receipt, queue gate, actual playback progress and waits without settling the terminal playback ACK. Keep sentence flush, per-part TTS and native reply observation times linked to the same run so voice delays can be measured while the turn is still running.

## [1.103.1] - 2026-10-02

### Fixed
- Master voice now distinguishes audio preparation and buffering from media-clock progress, and detects playback that makes no progress instead of displaying a speaking indicator indefinitely.
- Cancelling a master turn discards its current and queued audio; late playback rejections cannot cancel a newer retry.
- Streaming voice text follows the same audio without replaying it, and playback results retain bounded media state to diagnose silent or interrupted replies.

## [1.103.0] - 2026-10-02

### Changed
- Open the conversation secret control directly on a paste field: confirm a value, dotenv bundle or file for the current task, optionally save it to a vault, and search saved secrets to connect them with one click.
- Separate saved secrets, project connections, remote sharing and security in Settings. Keep automatic connection and advanced permissions one level deeper, and select known remote computers by name.

### Fixed
- Save to the current project without requiring prior project registration, while preserving the same running task and its canonical root.
- Keep explicit saved-key connections scoped to the chosen task/project and preserve disabled policies, expiry, selected fields, operations and fixed grant deadlines.

## [1.102.0] - 2026-10-02

### Added
- Configure the master's new work sessions with the built-in `master.worker` model role. Direct creation and Auto Prompt apply omitted provider, model, and effort defaults in code on the receiving computer; existing conversations retain their choices unless explicitly changed.
- Preserve accepted Auto Prompt model defaults across retries and settings changes, migrate an existing custom `master.worker` role without replacing other choices, and refuse delegation to workers that cannot honor the role.

### Fixed
- Recognize the documented `autoPrompt.submit` HTTP operation path, including its uppercase character, consistently on local and joined computers.

## [1.101.1] - 2026-10-02

### Fixed
- Keep authenticated local follow-up delegations linked to the original master across project handoffs, steering, Auto Prompt routing, and restarts. Report execution status separately from goal completion, and show when a submission cannot be tracked without resubmitting accepted work.
- Record permission decisions once and resume approved unfinished work in a fresh provider turn after the requesting turn ends normally. Current-turn notices cannot become standalone tasks; refusals, explicit stops, closed conversations, duplicate decisions, and worker updates preserve the continuation's lifecycle.
- Hold master reports only for an explicit owner stop, and preserve follow-up reporting when a permission continuation arrives after an earlier result.

## [1.101.0] - 2026-10-02

### Added
- **Password-encrypted secrets for agent tasks.** Settings → Secrets and the conversation's key button register individual values, dotenv bundles, and files for global, project, or current-task storage. Sharing rules select a computer, project, keys, dotenv fields, and allowed operations. Automatic project connections are discoverable on every eligible owner turn; manual connections last for the security task until revoked, expired, or explicitly ended.
- **Use secrets by reference.** Run-scoped agent tools and the `agent-session-tower secrets` CLI deliver permitted values through environment variables, stdin, or private temporary files; compare values and return scoped HMAC fingerprints without printing them. Consumer output is masked before returning to the agent, and a stable operation ID prevents uncertain requests from executing again.
- **Share with sessions on joined computers.** Separately approved secret-device fingerprints, exact project bindings, signed requests, and encrypted responses allow remote use without copying the source vault. Both source and recipient enforce task closure and revocation; unavailable or locked sources deny new use.
- **Encrypted migration and backup.** Initializing the vault migrates existing trigger secrets while preserving their IDs and grants. Backups include permanent encrypted secrets and exclude current-task values. Restoring waits for explicit password-protected import before applying dependent triggers.

The vault starts locked with a new execution worker. Encryption protects stored data; programs given secrets and code running as the same OS user remain trusted consumers.

## [1.100.2] - 2026-10-02

### Fixed
- **Recent task summaries now appear when hovering over a session on the canvas**, instead of a row in the session list. The card shows the latest three tasks after a short mouse hover and closes on click, canvas movement, zoom, scrolling or resize, including during the hover delay. The task summary above the chat message box is unchanged.

## [1.100.1] - 2026-10-02

### Fixed
- **Refreshing Tower no longer briefly shows sessions that should be hidden.** The session list and canvas wait for the information that hides Slack coordinator conversations and finished delegated work; an initial lookup that fails or times out offers a retry. Reconnecting keeps the last successful information, so those sessions do not briefly return.
- **The initial session snapshot is fetched once.** A new page uses the first live-stream snapshot instead of also requesting the same session snapshot over HTTP. The refresh button and refreshes after edits still work.

## [1.100.0] - 2026-10-01

### Changed
- **A page receives only the sessions it shows.** Opening Tower used to bring every session this computer ever saw, agent and review runs included (thousands, several megabytes); now it brings the open sessions inside the list's time window, those at work, and those a turn or Auto Prompt is waiting on (with the default one-day window, tens instead of thousands). Widening the time window, opening the archived list, or opening a session brings what that needs at once on the open connection (an opened session's subagents and agent runs only when it is opened), and narrowing lets it go. Counts, folder choices, folder search and saved canvas places still cover every session. The trigger editor asks for the sessions it can continue when it opens. Tower's tools, links between computers and pages from an older version still receive every session.

## [1.99.0] - 2026-10-01

### Added
- **Rest the pointer on a session in the session list to see its three latest tasks** (title, stage, when) in a card beside it, without opening it; it says how many earlier tasks there are and closes as soon as you move away, scroll or click.

### Changed
- **A session's task summary sits right above the message box** instead of under its title: the current task and its stage are in view where you write the next message. Opened, the task history unfolds upward toward the conversation, the newest task lowest, beside the current line.

## [1.98.1] - 2026-10-01

### Fixed
- **Pages load much faster, above all through the public address.** Tower compressed nothing it sent: every refresh moved the whole session list (several megabytes once agents have run many reviews) twice and the page's scripts again, since scripts were never cached once remote access was set up. The session list, its live updates and the page files are now compressed (brotli, or gzip), about five times smaller, and the build's script and style files stay cached in the browser.

## [1.98.0] - 2026-10-01

### Added
- **What each session is working on, at the top of its chat** (#46). After every turn, in Claude and Codex sessions alike (Tower's, your terminal's, triggers', the master's), a light model sums up the session's work as feature-level tasks: a title such as "Master agent voice does not play" and the stage it reached (investigating, designing, in review, PR opened, deployed …). The same work moves its task on; different work adds a task. The chat header shows the current task and its stage; tap it to see every task the session worked on, newest first. Summaries start with the first turn that ends after the update; nothing appears as a session or in Claude Code or Codex history, and a failed or slow summary never touches the turn.
- **Settings › Models › Session task summaries** (`sessions.summarizer`, Haiku with thinking off by default) chooses the model.
- `sessions_list` and `sessions_search` (MCP, `/api/v1`, the master) return each session's current `task` (title, stage) and its `tasks`; a list `query` also matches task titles. Quick lookups (`tower_query`) gain `sessions.task_title`, `sessions.task_stage` and a `session_tasks` table.

## [1.97.1] - 2026-10-01

### Fixed
- **A message that waits instead of going into the running turn says why.** The **지금 끼워넣기** (insert now) button disappeared without a word when the running turn was started elsewhere (a trigger, Slack or another computer, such as a trigger's issue run that the owner messages), when the message asked for another model or reasoning effort, or when it had to carry Tower's instructions. The waiting line now gives the reason, on joined computers too.
- **The insert button appears as soon as Claude can take the message.** A message queued while Claude was still starting stayed without the button until Claude wrote something, which a long tool call could put minutes away. While a Codex turn takes one inserted message, the others show they wait for it instead of offering a button that would fail.

## [1.97.0] - 2026-10-01

### Fixed
- **Master voice: an answer not read aloud is no longer dropped silently.** When the page could not play it or its sound was cut, the browser refused to play, it waited on the page too long, the page never answered, voice moved to another tab, or nothing in it could be read, the voice bar says so ("답을 끝까지 읽지 못했어요 · 재생이 끊겼어요"), with the conversation closed too. **답 다시 듣기** reads the whole answer again (the click also lets the browser play sound); × dismisses the notice. A blocked answer is heard again this way, instead of replaying audio the master had already given up on.
- An answer read aloud after its turn ended, or heard again, keeps up to 6,000 characters (was 3,000); one kept shorter than it was ends saying the rest is on the screen.

### Changed
- `master/voice-timings.json` keeps everything given to the page for a request (`says`: when, how many characters, when its sound started, the page's word on it and what failed) and how its reading ended (`outcome`: played or not, why, whether part was heard). The host log gets one `Master voice outcome` line per reading.

## [1.96.1] - 2026-10-01

### Fixed
- **The master's conversation can be opened again while voice is on.** The floating button ends voice then, so a conversation closed during voice could only come back with Shift+M. While it is closed, the voice bar now shows an open-chat button above the master settings icon.

## [1.96.0] - 2026-10-01

### Added
- **Tower's tools at `http://localhost:8000/mcp`**: an agent can use the same tools as `agent-session-tower mcp` by address (`claude mcp add --transport http tower-local http://localhost:8000/mcp`), so another computer that reaches this one's localhost through an SSH tunnel needs nothing installed. Only callers at this computer's localhost are answered; a page signed in from elsewhere is refused, and browsers cannot reach it.

## [1.95.0] - 2026-10-01

### Added
- **`agent-session-tower mcp`**: Tower's tools for your own agents on this computer. Register it once (`claude mcp add tower-local -- agent-session-tower mcp`, or the same with `codex mcp add`) and Claude Code, Codex or any MCP client you start yourself can use Tower as you: start and message sessions, answer approvals, manage skills, permissions, models, triggers, Slack, public agents, backups and joined computers, register issues, read sessions and terminals. It signs in like your localhost page, finds Tower again after a restart, never resends a change that may have run, and has its own budget for changes so your pages are never slowed (on joined computers too: the master and your agents together keep to half of what a joined computer allows). Registered for every session, it stays out of the master's way; the master keeps its own tools. `tower_guide` lists every route and each `/api/v1` operation's input.

### Changed
- The master agent's route guide now also lists skills, backups (still never made or applied by the master), the execution worker update, terminal resize, attachments and Auto Prompt suggestions, with a test that fails when a route the pages call is missing from it.

### Fixed
- The master can answer approvals whose ID contains a slash.

## [1.94.1] - 2026-09-30

### Fixed
- **Settings → Models** picks each model from the computer's whole list (for Claude: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) instead of a text field whose suggestions narrowed to what was already typed; **직접 입력…** (type a model) still takes a model the list does not have.
- Claude's model lists (chat, new session, triggers, Settings → Models) include **Fable** and name the model each alias selects.

## [1.94.0] - 2026-09-30

### Added
- **Settings → Models** (#35): one place for the provider, model and reasoning effort of every Claude/Codex call Tower makes by itself. Every such call now takes its model from a role there:
  - automatic judgments: Auto Prompt routing, the permission reviewer, skill proposals, Slack mention matching, reply intent, reply drafts and tone guide, GitHub reply intent, public agent judgments and the voice first reply;
  - starts: the master agent and the folder issue button;
  - defaults for new items: new chats, Auto Prompt, triggers, Slack and GitHub rules and public agents start with the role's choice, while items already made keep their own model. "Claude default" / "Codex default" (an empty model) leave the choice to the CLI.

  Judgments can run on the same provider as the work they judge, with a model for each provider. Initial values are what each call used before, so nothing changes after the update; the permission reviewer's and skill advisor's earlier choices are carried over, and their pickers now point to Settings → Models.
- **Roles for skills**: add roles such as `review.codex` and write the role name in a skill instead of a model. Each turn gets the role table in its Tower instructions, and the `models_get` tool and `agent-session-tower models args <role>` give the same model as flags for `codex exec` or `claude -p`.
- **Remote computers** follow their own model settings; pick the computer in Settings → Models to see and change them there.
- One-shot judgments now pass their reasoning effort to Claude (`--effort`, or thinking off) and Codex, and accept any model the provider offers.
- Backups include the model settings.

## [1.93.0] - 2026-09-30

### Added
- **Agents can ask Tower to run one command once** (`permissions_run`). For a one-off action such as stopping one process (`kill 13229`), an agent no longer needs a lasting rule that allows a whole family of commands. Tower's permission reviewer (or you, in **권한**) judges the exact command. Once it is allowed, Tower runs it in the conversation's folder with no input, stops it after at most 10 minutes, and keeps the first and last 64 KiB of its output. The agent reads the result with `permissions_runResult`; if it ended its turn first and you (or the reviewer's setting) asked for the conversation to hear decisions, the result arrives as a message once the conversation is idle. A `claude` or `codex` the command starts counts as that conversation's own run. Asking again with the same command returns the same request, so nothing runs twice. `sudo`, disk tools, and downloads piped into a shell always wait for you. After a restart, a command left running is stopped only when Tower can prove it is still the same process; otherwise its result is marked unknown.
- **Rules for one conversation.** The reviewer can allow a wide rule for one conversation only (`scope: "conversation"`). It reaches only that conversation's Claude Code turns and is removed when the conversation closes or 24 hours after it was allowed. Where you allowed a command that overlaps a rule the reviewer allowed, your rule decides in the turns it reaches. Codex cannot take rules for one conversation, so Codex agents are pointed to `permissions_run` instead. The rules are listed under **대화 한정** with their expiry.

## [1.92.1] - 2026-09-30

### Fixed
- Alignment fixes (#25):
  - with the sidebar closed, the canvas zoom tools sit on the settings button's line, at its height and just left of it, in every language and width;
  - checkboxes in the trigger editor (assign, close, include pull requests and teams) sit beside their text from the left instead of centered above it;
  - the trigger panel's computer picker keeps its label on one line.
- **Slack automation** offers the Verse8 PR example only while there are no rules yet.

## [1.92.0] - 2026-09-30

### Added
- **Backup and restore of Tower's settings** (#19). **Settings → Backup** exports everything Tower is set up with on this computer as one file:
  - triggers (with their header secrets and what GitHub watches already took), permission rules and automatic review;
  - Slack (connection, rules, tone) and GitHub automation rules;
  - public agents, fast judgment, folder groups and hiding, and the folders kept from remote sharing;
  - Tower's skills with where they apply, their pins and your guidance;
  - the master's voice settings.

  Sessions, conversations, remote computer links, notification devices and the remote login account stay on each computer. The file holds tokens and API keys, so it is always encrypted with a passphrase of at least 8 characters (scrypt and AES-256-GCM).
- Restoring checks the file first and shows what it holds. Nothing changes until you confirm. Files it replaces are copied to `restore/before-*` in the state folder, and running turns and shells are never interrupted:
  - folder, sharing, fast judgment, backup and master settings apply at once;
  - the execution worker hands over at its next quiet moment to a new worker, which applies triggers, permissions, Slack, public agents and skills before it starts them.

  Triggers are restored the way your own edits would be: an unchanged trigger keeps its schedule, and a changed or new one counts from now. An issue or review request either computer's GitHub watch already took is not taken again. A trigger whose folder or conversation this computer lacks comes in turned off. Skills get back exactly the projects they applied to and their pins; a project folder missing on this computer is left out. Settings a service here would refuse are not written. Everything left out is reported. A backup made by a newer Tower is refused until this one is updated. A backup from another computer comes with a reminder to stop the Tower there first, since both would otherwise run the same automation.
- **Automatic backups** to S3-compatible storage such as Cloudflare R2: set the endpoint, bucket, access key and a passphrase, and Tower uploads an encrypted backup every 24 hours (1–168). It keeps the newest 14 of this computer's backups (1–100); a key that may only write still backs up and shows a warning. **연결 테스트**, **지금 백업**, and the list of stored backups with download are on the same page. The secret key and passphrase are never shown again.

## [1.91.0] - 2026-09-30

### Changed
- **The permission reviewer trusts your agents and reads more of what you said.** Tower's agents do your work on your own computer, so the reviewer no longer guards against an agent forging your instructions, and skips far less often:
  - Your words are the whole conversation, read from its start: every message you sent, and your answers to the agent's questions, including ones not in its history yet. It works in conversations started before 1.89, outside Tower, or through the master too. It still leaves a request to you when the history cannot be read to its start, or when what you said is too long to pass on whole.
  - The Tower skills that apply to the project and your guidance count as they are now; there is nothing to confirm. The **확인 필요** badges, **이 내용 확인** and **확인 기록 지우기** are gone.
  - The project's `AGENTS.md` and `CLAUDE.md` count as your instructions, as they are in the project's folder.
  - A trigger's instructions count whoever changed them last.
- Command rules may carry options. `gh pr merge --squash`, `git push -u origin main` or `git commit -m wip` are reviewed; dangerous options in any spelling git accepts (`--force-with-lease`, `--del`, `-vf`, `+main`, `git checkout -B`, `git log --output=…`) and options before a subcommand (`git -C dir push`) still leave the rule to you.
- `owner-prompts.json` from 1.89/1.90 is no longer used and can be deleted.
## [1.90.1] - 2026-09-30

### Fixed
- **Terminals open again after a long-running terminal host lost its credential.** The terminal host, execution worker and master host keep their connection files in `/tmp`, where cleaners delete old files. When the terminal host's credential was removed, the host kept running and holding its lock, so no new host could start and every new terminal failed after 30 seconds. Each host now writes a removed credential again within 5 seconds and keeps its files fresh so cleaners leave them alone.

## [1.90.0] - 2026-09-30

### Changed
- **Slack conversations reply without waiting for you** (#17). A Slack coordinator can now post in its thread on its own, as it could already add reactions: an acknowledgement, a clarifying question, or a verified result. It follows your rules, including one that asks to review replies first; a reply you did not ask for carries the "Sent by …'s agent" note, as autoReply reports do. Each reply has its own key, so a retry never posts it twice, and a send whose result is uncertain is never repeated.
- Telling Tower not to send (for example "슬랙에 보내지 마세요") holds every reply in that Slack conversation, including a rule's automatic report, until you give a send permission or approve a reply. While Tower cannot interpret one of your messages there, replies wait until it understands the next one. Proposals, approvals and autoReply reports work as before. GitHub issue comments still need your permission.

## [1.89.0] - 2026-09-30

### Added
- **권한 자동 검토.** When an agent asks for a permission with `permissions_request`, Tower's reviewer can decide it instead of waiting for you. Turn it on in 권한 → 요청 and pick the model (Claude opus/sonnet or Codex sol/terra, default reasoning). It applies in every project.
- A separate, tool-less model run reads:
  - **what you set down for that work**:
    - the prompts you typed in Tower in that conversation. They are kept apart from run history, whole, from the conversation's start in Tower. Continuations, notices and the master's messages are not counted.
    - a trigger whose instructions you last wrote;
    - Tower skills you applied to that project in Tower, and your guidance, at the text you saved or confirmed;
    - the rules you already allowed.
  - **the rest, as context only**:
    - the request and the agent's reason;
    - the project's `AGENTS.md`/`CLAUDE.md` from the upstream default branch. Agents can move local branches, so these are never taken as your word.
    - the recent conversation, and earlier requests.

  Context can never create consent.
- The reviewer answers one of three ways:
  - **허용**: the step is part of the task you asked for and not destructive. The rule is added for that project only (a global request is narrowed to the project), with the same or a longer prefix. It is marked 자동 검토로 허용, with its reason.
  - **범위 축소 요청**: the request is withdrawn and the agent is told the narrower rule to ask for; the new request is reviewed again. A conversation's third such answer in a day goes to you. So does one the agent cannot be told.
  - **소유자 판단 필요**: the request waits for you with the reviewer's reason. The reviewer never refuses; only you do.
- With **검토 결과를 요청한 대화에 알리기** on, the conversation hears the decision and continues. The notice runs with that conversation's own origin and approvals, never as yours.
- The reviewer does not decide, and the request waits for you, when:
  - the conversation started outside Tower or before this release, is too long to keep your words whole, or got owner messages you did not type in Tower there (the master relaying, another computer, an Auto Prompt through the API);
  - words in the conversation that Tower did not send (typed after resuming it in the native CLI), or a trigger whose instructions you did not write as they stand now;
  - a skill or your guidance changed, or a confirmed skill was removed or taken off the project, since you confirmed it. Skills removed outside Tower are listed in 스킬 with **확인 기록 지우기**.

  If you say more in the conversation, or confirm or change something, while the model is answering, the request is reviewed again (after three times, it waits for you). A narrower-rule answer the agent cannot be told (the notice is off, or the conversation cannot be reached) waits for you too.
- Some requests always wait for you, whatever the model says:
  - rules for a whole program or tool, `Bash(…)` written as a Claude rule, and MCP tools that send, delete, run, deploy or pay;
  - file rules outside the project, for the whole project, as a pattern, or in hidden folders (`.git`, `.claude`, `.ssh`);
  - command rules that contain options or special characters (the reviewer allows commands such as `git push origin main` or `gh pr merge`, never `git push --force-with-lease`);
  - programs called by path or in upper case, and wrappers or code runners (`xargs`, `timeout`, `env`, `npx`, `node`, `python3`, `go`);
  - never-allowed commands at the start of the rule (`git reset --hard`, `gh api`, `gh secret`, `npm exec`, `git config`, `git credential`, `git remote`, `docker run`, `docker exec`, `kubectl exec`, …);
  - deleting, network and privilege programs anywhere in it (`rm`, `curl`, `ssh`, `sudo`, …);
  - rules that overlap a rule you made yourself;
  - public agents' requests.
- An allowed rule also gets deny rules:
  - for the destructive options of its command (`git switch --discard-changes`, `git checkout -B`, …);
  - for the dangerous ends of shorter never-allowed commands, such as `git reset` + `--hard`;
  - for any git command, the options that run a program or write a file: `--upload-pack`, `--receive-pack`, `--exec`, `--output`, `--open-files-in-pager`, `-O`, `--ext-diff`, `--textconv`.

  For example, an allowed `git push` also denies:
  - for Claude Code, `--force` (with `--force-with-lease` and `--force=…`), `-f`, `--delete`, `--mirror` and `+refspec` anywhere after it, and every shorter spelling git accepts (`--d`, `--del`, …) as a whole word, so options that only share a start (`--follow-tags`) stay allowed;
  - for Codex, the same options and their spellings right after the prefix.

  Some variants stay open:
  - Codex rules only match whole words right after the prefix, so Codex does not block `git push origin main --force`, `--force-with-lease=main`, `-fu` or `+main` under an allowed `git push`.
  - Claude Code does not block combined short options such as `-vf`, or a trailing `:ref` that deletes a remote branch (`git push origin :main`).
- While auto-review is on, skills and guidance show **확인 필요** when their text, or the projects a skill applies to, changed since you saved or confirmed them in Tower. Open one and press **이 내용 확인** to let the reviewer rely on it. Skills saved before this release need that once. The master's or another computer's changes never count as yours.
- Agents see the reviewer's verdict and reason in `permissions_list`, and the Tower guidance asks them to name the step of your task that needs a permission.

### Changed
- The waiting-requests count and badge leave out requests the reviewer is still checking; the open permissions panel follows a review until it ends.
- A review under way when the worker hands over finishes first; waiting reviews continue in the new worker.
- Tower keeps what you type in each conversation in `owner-prompts.json` in its state folder (owner-only file). If it cannot be saved, the message is refused like one whose run cannot be saved.
- Changing what a rule the reviewer made allows makes it yours, without its deny rules; changing only its note or agents keeps them. Saving or allowing a rule of your own that overlaps one the reviewer made (`git push --force-with-lease` beside `git push`) removes the reviewer's, so its deny rules never block yours.
- Going back to 1.88 or earlier reads requests the reviewer withdrew as waiting and its rules as yours, without their deny rules. Delete the 자동 검토로 허용 rules before downgrading.

## [1.88.0] - 2026-09-30

### Added
- **Every Tower version on the canvas.** The version on a computer's card now opens a panel on hover, focus or tap. It lists the version of each of Tower's processes: the web server, the execution worker, the terminal host and the master host. A process that is not running shows as such. One that still runs an older release is marked, with when it moves: the worker when no work runs, the terminal host once every terminal is closed, the master host when it restarts. A dot on the version says something is still waiting to move. The panel is drawn above the canvas, so it stays readable when the canvas is zoomed out. Joined computers show the versions their own state reports.
- The web server looks at the terminal and master hosts every half minute. It never starts them and never keeps them from stopping when idle: the terminal host is asked once per run.

## [1.87.0] - 2026-09-30

### Changed
- **GitHub issue triggers are one kind with options.** 새 이슈, 열린 이슈 차례로 and 나에게 할당 are now a single **이슈** watch; PR review requests stay separate. You choose:
  - **담당자**: anyone, only issues assigned to you (with no repositories, from every repository you can see), or only unassigned ones.
  - **포함 라벨** (any of them) and **제외 라벨** (any of them skips the issue, for example `draft` or `hold`), plus authors and author range under advanced settings.
  - **시작점**: only issues that appear or come to match from now on (the default for a new trigger), or also the issues already open.
  - **순서** (oldest or newest first) and **동시에 처리할 이슈 수** (1 to 5).
  - Whether to assign the issue to the connected account when its run starts, and whether to close it when the run completes. Both are off for a new trigger.
- Each issue is worked on once while it stays open; it is remembered even if it is unassigned or a label changes, and taken again only after it is closed and reopened (it used to run again when it was assigned again). Editing what a trigger covers keeps what it took and what was waiting for its turn; with **시작점** set to from now, issues that newly match but were opened before the last check are left alone.
- Saved triggers move to the new kind by themselves and take nothing they had already seen: new-issue triggers start from now (as many at once as their overlapping runs used to), open-issue queues keep going, and assigned-to-me triggers keep the issues already assigned.
- The overlap setting is no longer shown for issue triggers; how many issues run at once is the concurrency option. At the hourly maximum an issue trigger waits instead of pausing.
- Switching **시작점** to also take open issues takes the ones a from-now trigger had left alone; switching back to from now leaves the rest of the backlog and takes only issues that appear afterwards.
- Each check reads the watched repositories' whole open lists (up to 1,000 open issues and pull requests per repository), within the shared budget of 60 trigger requests a minute. Without repositories, issues that left your assigned list are looked up at most once an hour to learn whether they closed.
- While the worker is still on 1.86 after the update, saving an issue trigger or its preview fails until the worker switches; a 1.86 page, controller or agent that sends the earlier kinds is refused by 1.87. Going back to 1.86 cannot read the saved triggers (it sets the file aside); keep a copy of `trigger-engine.json` before downgrading.

### Added
- **처리 순서 미리보기** in the issue trigger editor lists the open issues the chosen options would work on, in order, marking each as up next (numbered), in progress, done before, or skipped because it was already there. It reads GitHub only; nothing is recorded or run. Agents can ask for the same list (`triggers_previewIssues`).

### Fixed
- Checkboxes in the trigger editor sit beside their text again instead of above it.
- The pull request option applies to every issue trigger and is always shown, so a hidden setting never changes what runs.

## [1.86.0] - 2026-09-30

### Added
- **Update now.** When the header shows **실행 워커 업데이트 대기** (worker update pending) and the worker can do it, a **지금 업데이트** button switches to the new version without waiting for a moment when nothing runs. New turns wait. Every running turn is asked to reach a safe stopping point, note what is done and what remains, and end. After at most 10 minutes, turns still running are stopped. Tower then switches to the new worker, and every interrupted conversation continues there with a turn that first checks what was already done. Messages sent meanwhile start after the switch; nothing queued is dropped. Slack and GitHub coordinator conversations, triggers and public agents follow their conversation into the continuation. Work a coordinator delegated is stopped at the deadline, and its coordinator hears how it ended and decides what follows. While it waits, the header counts down. The button is not offered while a service update is still being verified, nor by a worker from before this version, which still switches at its next quiet moment. A turn you stop yourself while it waits is not brought back. If the switch still cannot happen 10 minutes after the deadline, new turns start again on the current worker.

### Fixed
- A restarted worker no longer starts restored turns before their tools and trigger checks are set up.
- A delegated task's result notice that a full queue refused is sent again later instead of being marked as failed, and the task's run is kept until its workflow is done with it.

## [1.85.0] - 2026-09-30

### Added
- **Register an issue from a project folder.** The header of a folder that is a git repository has an issue button (also in the folder's settings menu). It opens a short form: describe the bug, feature or task in a few words, choose Claude Code or Codex, and send. Tower starts a session in that folder, named **이슈 등록: …**, that reads the related code, checks the open issues for a duplicate, writes the issue up (summary, current and expected behaviour, related code, direction, done when, open questions) and registers it in the repository the folder's git remote points to (GitHub with `gh`, GitLab with `glab`), using only labels the repository already has. It changes no code. Folders on joined computers work the same way.
- The steps live in a shared Tower skill, **register-issue**, which Tower makes once for every project. Edit it in the Skills panel to change how issues are written; your edits are kept, and a removed skill is not made again. A skill of that name you already have is left as it is. When a project has its own issue skill or instructions (for example a `/issue` skill that files issues in another repository), the session follows those instead.
- The master agent may register issues whenever you ask, without confirming: it starts the same session in the project's folder.

## [1.84.1] - 2026-09-30

### Fixed
- **Claude usage no longer disappears from a computer after it restarts.** Anthropic's usage service often refuses reads for a while (HTTP 429), and Claude Code and every other Tower on the account share its limit. A Tower that had just restarted, for example a joined computer after an automatic update, then had no reading at all and showed **— Claude · 정보 없음**. Tower now keeps the last reading of each account's usage in `provider-usage.json` in its state folder (only the percentages, window lengths and reset times) and shows it, marked with `*` as earlier information, until a new reading arrives. Windows whose reset has passed are not shown again. When the current sign-in cannot show usage at all (for example Claude Code now uses an API key), the kept reading is dropped instead of showing another account's quota.
- Tower asks for Claude usage at most every 3 minutes, and after a refusal waits 5, then 10, then 15 minutes before asking again, instead of every minute. A refused Claude read no longer slows the Codex readings. A window that resets during the wait is read again at once.
- A joined computer now tells the controlling Tower why its usage is missing, so the tooltip says, for example, that the usage lookup limit was reached.

## [1.84.0] - 2026-09-30

### Added
- **GitHub triggers can work through every open issue, one after another.** A new kind of GitHub trigger, **열린 이슈를 하나씩 차례로 처리**, takes the open issues in the watched repositories, those opened before the trigger was set up included, oldest first. It hands one issue to a run and takes the next as soon as that run ends, without waiting for the next scheduled check. **동시에 처리할 이슈 수** sets how many are worked on at once (1 to 5; the trigger's own overlap setting does not apply). The label, author and author-range filters work as for new issues.
- When a run starts, Tower assigns its issue to the connected GitHub account; when the run completes, Tower closes the issue. A run whose work is unfinished, or that needs your decision, comments on the issue and ends its report with `TOWER_KEEP_ISSUE_OPEN`; Tower then leaves the issue open. A run that fails or is stopped never closes its issue. Both steps can be turned off, and coordinator rules never close issues. The run history shows what was done to each issue.
- Each issue is taken once while it stays open, so one left open is not started again; turning the trigger off and on takes the ones still open again. An issue closed and reopened is taken again. At the hourly maximum this kind of trigger waits and goes on in the next hour instead of pausing. If a run cannot even start (for example its folder is gone), the trigger pauses rather than take the next issues the same way. A close that GitHub refuses for a while (rate limits, its own errors) is tried again a few times. Only a last line of exactly `TOWER_KEEP_ISSUE_OPEN` in the run's report keeps an issue open; a mention elsewhere does not.

## [1.83.0] - 2026-09-29

### Fixed
- **Helper runs stay hidden even when they are detached.** When an agent in a Tower turn started a `claude -p` review as `( claude -p … ) &`, the run lost its link to the agent before Tower looked, so it showed on the canvas as your own session. Every Claude and Codex turn Tower runs now finds a small `claude`/`codex` shim first on its PATH. It notes which session started the run (Claude Code and Codex pass their session id to every command, and a detached run keeps it), gives a new `claude -p` run its session id so the note names that exact run, and then starts the real program with the same arguments. Other runs are matched by process id and start time while they run (including the program a launcher script such as npm's `codex` starts). Subcommands like `claude mcp …` are passed through untouched, and Tower's own processes drop the identity of an agent turn that restarted them, so a `claude -p` you type in a Tower terminal is never taken for an agent's helper. The proof is kept like the process-tree proof, so the run stays under its launcher after it ends.

### Added
- **Folders only helper runs worked in are removed when their work is done.** A git worktree where only hidden runs (an agent's `codex exec` or `claude -p`, reviews) worked is removed once those runs have been done for 30 minutes and every open conversation that named the folder (the one that made it included) has been quiet for 2 hours, even while that conversation stays open. A helper run nobody is known to have started no longer keeps a closed conversation's worktree either. It needs a transcript that proves a conversation made it with `git worktree add`, so a worktree you made by hand is never removed this way. A conversation you see working there, uncommitted changes, unpushed commits, a program in it and pinned or trigger folders keep it as before. Its ignored files (notes, review records) are moved to `worktree-files/` in Tower's state folder and are never pruned (up to 1 GB for such folders; beyond that the folder stays). Leftovers from earlier are cleaned up over the next passes.
- The agents' guidance asks them to start helper agents in the foreground or with their tool's background option, never detached, and to remove a worktree made for them as soon as they are done.

## [1.82.0] - 2026-09-29

### Changed
- **One settings button replaces the header icons and the canvas cog.** Triggers, skills, permissions, fast judgments, remote computers, notifications, account and the canvas settings now live in one Settings dialog. Its menu on the left names every section; the right shows one section in the same frame each time: a title, one line saying what it is for, tabs, and the body. On a phone the dialog shows the menu first and then one section, with a way back.
- **The settings button stays in the top right when the header is hidden.** Its mark shows waiting permission requests first (in red), then skill proposals, and otherwise a dot when a trigger needs a look or another Tower started controlling this computer. So a permission request is seen while you work on the canvas. Waiting requests are checked every 20 seconds and again when the page comes back into view.
- The canvas settings (layout, animated connections, show all, language, chat text size) are in **General**. Shift+A still switches show all.
- Moving between sections keeps what you were writing. Esc first closes an open editor. Closing the dialog while a trigger, skill or rule is being edited asks before the changes are dropped.
- A folder's "Skills for this folder" and "Permissions for this folder" open that section narrowed to the folder, marked by a chip beside the title; clear the chip to see everything.
- The master agent opens these panels as sections of the settings.

## [1.81.0] - 2026-09-29

### Added
- **One skill for several projects.** A skill kept in Tower now applies to every project or to the projects you choose for it, picked from a searchable list of the projects Tower knows. Tower links it into each chosen project's `.agents/skills` and `.claude/skills` (or the global folders when it applies everywhere) and names it at the start of its turns only there, so a deploy skill can go to the projects that deploy automatically and a working-method skill to all of them. Changing the projects moves the links; a project that already has a different skill of the same name, or whose skills folder is a link, is refused before anything changes. Opened from a project folder, each skill has a switch for that project.
- A project folder's menu shows a dot on **이 폴더의 스킬** when a suggested skill is waiting for it.
- Backups carry each skill's projects; importing one applies it to the projects this Tower knows, and replacing a skill keeps where it applies here.

### Changed
- **The Skills panel opens on the skills kept in Tower** (none until you register or move one there), one quiet row each with where it applies; a click opens it. **추천** sits beside it with its count. Every other skill on the computer, your guidance, backups and the suggestion settings moved behind the ⋯ menu.
- Skills Tower already kept apply where they did: global ones to every project, a project's own to that project.

## [1.80.1] - 2026-09-29

### Changed
- The computer status rings (C, R, D) on the canvas are drawn one step thinner.

## [1.80.0] - 2026-09-29

### Added
- **Worktrees a conversation made are removed once its work is over.** Agents create git worktrees for reviews and parallel work and often leave them behind, each with a full checkout and installed dependencies. When you close a conversation, or 30 minutes after a trigger or Slack task finished its work, Tower removes the worktrees that conversation, its subagents and the runs it launched created with `git worktree add`. It keeps a worktree, and says why on the conversation's page, when:
  - an open conversation works in it or refers to the folder in its requests, answers or commands;
  - a program works in it or names it on its command line (directly or through a symlink), a trigger works there, or you pinned it as a project;
  - it has uncommitted changes (including edits hidden from `git status`), is locked, or has commits not yet pushed;
  - it holds another repository with work of its own (uncommitted changes, commits no remote has, worktrees of its own).

  Files git ignores that no tool makes again (notes, review records in `tmp/`, a local `.env`) are moved to `worktree-files/` in Tower's state folder first; installed dependencies and build output go. Branches are never deleted, and git never removes a worktree with changes. A kept worktree is checked again every hour. Runs an agent started on its own, without a conversation known to have launched them, are left alone.
- The agents' guidance now asks them to remove a review worktree as soon as the review is done.

## [1.79.0] - 2026-09-29

### Added
- **Computer status rings on the canvas.** Under each computer's version, three small rings show how busy it is: **C** (CPU), **R** (memory) and **D** (the disk that holds Tower's state). A ring turns amber from 75% and red from 90%. Hover, focus or tap them for the details: CPU share, core count and load averages, memory and disk used out of the total, disk space left, and when it was measured. Each Tower measures its own computer every 10 seconds and joined computers send theirs to the Tower that controls them, so their rings appear once they run this version; a computer out of reach shows none. On a Mac, memory is counted as Activity Monitor's "Memory Used", not the much smaller free-page count.

### Changed
- The computer card on the canvas is slightly taller to fit the rings; folders placed automatically sit correspondingly lower.

## [1.78.2] - 2026-09-29

### Changed
- **Allow rules now reach every Claude Code turn Tower starts, as they already did for Codex.** Triggers, Slack and GitHub watches and public agents are work you set up, and you chose what it may do. Until now their Claude turns did not get your allow rules, so an action you allowed (for example a deploy command for a deploy public agent) was still refused there by the auto-mode classifier. Work set to wait for your approval no longer asks about actions you allowed either. The Permissions panel says where rules apply. Claude sessions you open yourself in a terminal are still not affected.

## [1.78.1] - 2026-09-29

### Fixed
- **Slack and GitHub coordinators can add reactions at any time.** Emoji reactions no longer wait for reply permission, which only came from an autoReply rule's delegation or the owner. So a rule's "put :loading: on first" works as its first step, and a coordinator that asks for nothing to be sent can still react. Replies still need the same permission as before.

## [1.78.0] - 2026-09-29

### Added
- **Slack: a working emoji the moment a request arrives.** Set **작업 중 표시 이모지** (working emoji) in the Slack panel's connection tab, for example `loading`. Tower puts it on a mention right when it arrives, and on a later thread message as soon as it is found to ask something of you (at once when it mentions you, after the quick judgment otherwise), without waiting for the agent. It comes off by itself when that work is done: no agent turn, delegated task or message on its way is left. Empty turns it off (the default).
  - Rules no longer need a "put :loading: on first" step; they can keep only the result emoji (✅ / ❌). If a rule still adds and removes the same emoji, nothing conflicts.
  - Each reaction call is made once: if Slack refuses one, it is noted in the conversation's record rather than retried every second.

### Changed
- **Slack: reactions go on the message that asked.** When a later message in the thread asks for more work (for example "dev 배포 부탁드립니다" after a review), the agent now reacts on that message instead of the first request of the thread.

## [1.77.0] - 2026-09-29

### Changed
- **The master's floating button stands alone until you need more.** Nothing sits beside it by default: today's voice cost and the voice line no longer stay next to it after voice is turned off.
  - Opening the master's conversation slides the microphone and settings icons out from under the button; closing the conversation (a click on the background too) folds them back. Cost and transcription totals show only while voice is on and in the master's settings.
  - The microphone icon starts a voice conversation. The button then turns into a microphone, and pressing it ends the conversation: what was playing stops, and speech still being written down is dropped rather than sent. The conversation window stays as it was. There is no separate "음성 끄기" button any more. Shift+M still opens and closes the conversation.
  - "듣기 끄기" is now **마이크 뮤트** / **뮤트 해제**. A muted microphone stays muted until you unmute it, even after news of finished work is read aloud (which used to turn listening back on); answers and news are still read.
- **Long speech stays readable while you talk.** What is being written down shows up to five lines (four on phones) and keeps its latest words in view as it grows, with a blinking caret while writing goes on and a fade at the top when earlier words scroll out. Scroll up to read what came before; scrolling back down, or starting a new sentence, follows again.

## [1.76.0] - 2026-09-29

### Added
- **Skills and your guidance are kept in Tower.** So they can be backed up and moved to another computer, choosing which ones go.
  - A skill made in Tower (new, or an accepted proposal) is now kept in Tower's own folder, `<state>/skills` (`global/<name>`, and `projects/<folder>-<hash>/<name>` with the project's path beside it). Claude Code and Codex reach it through links in `~/.agents/skills` and `~/.claude/skills`, or in the project's `.agents/skills` and `.claude/skills`. In a git project those links are added to the repository's own `.git/info/exclude`, so they never show up as changes.
  - This means a project skill made in Tower is no longer a file of the repository: to share one with a team, commit a copy yourself.
  - Skills elsewhere show a **타워로 옮기기** (move into Tower) button: the folder is copied into Tower and a link takes its place, identical per-agent copies included, so the agents keep using the same skill. A move is recorded before it starts; if Tower stops half way, it is finished (or undone, when the copy was not complete) at the next start. A pin on the skill moves with it. Skills git tracks (a repository's shared skills, a dotfiles repository), skills with a link inside, and per-agent copies that differ are not moved. Moving a skill installed with the `skills` command warns that later `skills` updates change the folder kept in Tower.
  - **Tower keeps** and **Not linked** marks: a skill kept in Tower whose links are missing (for example right after an import on a new computer) is still listed, and **link** puts them back.
  - **지침** (guidance) tab: your own guidance, kept in `<state>/guidance/owner.md`, goes to every Claude Code and Codex conversation after Tower's own text. Tower's built-in text is shown there too.
  - **백업** (backup) tab: tick the skills kept in Tower and your guidance, and download them as one file. On another computer, open the file there: each skill shows what will happen (added; replaces the Tower skill of that name, when you choose so; skipped when a skill of that name exists outside Tower). A project skill goes to a project folder you choose, pins can come along, and the guidance in the backup is shown and taken only when you choose to (replacing or following yours, and only when every chosen skill came in). Files in a backup are checked before anything is written (names, paths, SKILL.md, 20 MB).
  - Needs the execution worker of this version; until it switches, the new tabs say so.

## [1.75.0] - 2026-09-29

### Added
- **Permissions: one place for what Claude Code and Codex may do without asking, and agents can ask you for a permission.** Open it from the shield button in the header (the badge counts requests waiting for you), or for one project from its folder menu ("이 폴더의 권한").
  - A rule is either a command prefix such as `gh pr merge` (allowed with any arguments, for Claude Code, Codex or both) or a Claude Code rule for other tools such as `WebFetch(domain:example.com)`. It applies to every project or to one project. Each rule shows exactly what each agent reads (`Bash(gh pr merge *)`, `prefix_rule(pattern=["gh", "pr", "merge"], decision="allow")`). Quotes, pipes, redirects and wildcards are refused, and broad rules such as a bare `git` or `python` get a warning.
  - An agent in a turn you started from Tower asks with the new `permissions_request` tool when Claude Code or Codex refused or keeps asking about an action the task needs (for example the auto-mode classifier refusing `gh pr merge`). It gives the narrowest rule and why, and is told not to work around the refusal. The request shows under Requests with its reason, the conversation and the exact rules. You can allow it, edit it first (for example make it apply to every project or to both agents), or refuse it.
  - With "결정을 요청한 대화에 보내 이어서 진행" (on by default), your decision goes to that conversation as your next message, after the turn under way if the agent is still working. The agent then goes on, since an allowed rule applies from its next turn. `permissions_list` also shows an agent its requests and the rules for its folder.
  - Claude Code receives the rules as settings of the turns you start from Tower (and work your agents start): every project's rules, and a project's rules in that folder and the folders inside it. Turns that handle outside content (triggers, Slack, GitHub, public agents) keep the auto-mode classifier's review. Your own settings files are never rewritten, and Claude sessions you open yourself in a terminal are not affected.
  - Codex reads them from `tower.rules` files that only Tower writes: `~/.codex/rules/tower.rules`, and `<project>/.codex/rules/tower.rules` for project rules (read in trusted projects). Codex cannot take rules per run, so every Codex run on this computer reads them, triggers and public agents included; the panel says so next to each Codex rule. Tower adds a project file to the repository's own exclude list so it stays out of git. It never changes a rules file it did not write, a committed one, or one reached through a linked folder, and only the Tower on the default state folder writes the file for every project.
  - Up to 200 rules. To remove Tower's Codex rules without Tower, delete the `tower.rules` files named above.
  - Only allow rules are managed; deny and ask rules stay in each agent's own settings. Requests come only from turns you started on this computer; agents cannot save, edit or decide rules.

## [1.74.1] - 2026-09-29

### Fixed
- **Claude reviews another agent started no longer come back on the canvas after Tower updates.** A `claude -p` run started inside an agent's turn (for example the Claude Fable check in a PR review) showed as your own session once Tower had updated after the run finished.
  - Such a run carries no mark of who started it: Tower can only see it under the launching agent's process while it runs. That proof was kept only in the execution worker's memory, and every update starts a new worker, so a run that had already finished could never be proven again. Codex runs were not affected; they carry their own mark.
  - The proof is now saved in the state folder (`agent-launches.json`), so each new worker keeps it. A worker handing over saves what it proved first and then writes nothing more.
  - A proof is forgotten when its conversation's file is deleted, never because a history folder could not be read.
  - Runs that finished before this version have no saved proof and stay visible until you close them.

## [1.74.0] - 2026-09-29

### Added
- **Reading speed in the master's voice settings.** Under the voice list, choose 1.0×, 1.2×, 1.4×, 1.6×, 1.8× or 2.0×; the choice is saved and a short sample of the current voice plays at once at that speed (clicking the chosen speed plays it again).
  - It applies to everything read aloud: answers, answers read while they are written, the first words after a spoken request, news of finished work, notices and voice samples. A speed chosen while something is being read is heard within a second.
  - The pitch stays the same: the browser plays faster with the pitch kept (also on iPhone Safari, where the speed is set again when sound starts).
  - Audio cut off by a web restart is still fetched again from the right place, since the place is measured in the audio itself.
  - The default stays 1.0× (as before). ElevenLabs' own speed setting is not used: it is not offered for the v3 voices and goes only to 1.2× elsewhere, so the audio made, its cost and the kept samples are unchanged.

## [1.73.0] - 2026-09-29

### Changed
- **The master's first words after a spoken request fit the request, and no recorded sentence is said any more.** Instead of "네, 확인해 볼게요." picked at random, Claude's fastest model (Haiku, thinking off, no tools) writes one short sentence from what you said, such as "SORI 광고 성과를 확인해 볼게요.", while the request goes to the master.
  - It states no facts or results and asks nothing; for a greeting or a thank-you nothing is said.
  - While voice is on, one Claude Code process waits ready, so the sentence comes 0.7–1 s after the request (measured), and it is heard before the master's answer. One not ready within 2.5 s, or ready only after the answer began, is not said.
  - It runs only through your Claude subscription sign-in (checked before every process starts), keeps no conversation anywhere and never appears as a session. Without a Claude subscription sign-in, nothing is said before the answer.
  - Each one counts against the daily voice limit: its reading, and $0.002 for the model call.
  - The master is told such a sentence may already have been said, so it starts with the substance.
- **"아직 하고 있어요." is gone.** A long turn is heard through what the master writes as it works. Recordings kept for the old sentences are removed.

## [1.72.0] - 2026-09-29

### Changed
- **The master reads its answer aloud while it writes it.** The first sentence is heard about a second after the master starts writing, instead of after the whole turn ended (5–11 seconds later before). Measured on real answers: the first sound came 0.7–1.1 s after the first words.
  - What the master writes before using a tool is read at once, then its answer after the tool; each is heard once. When the turn ends, only what was not read yet is read.
  - A finished turn is answered at once, no longer at the next five-second look.
  - The recorded "네, 확인해 볼게요." still comes first; the answer waits for it, and one still waiting when the answer begins is dropped. "아직 하고 있어요." is no longer said once the answer has begun.
  - The tone is set by the first words; once serious words come, the rest of the answer is read calmly.
  - Restarting the web or replacing the master's host neither repeats nor loses what is read: audio cut off partway is fetched again from where it was, and a host that is reading is not replaced.
  - When each answer's first sound came is kept for the latest 200 answers: `GET /api/master/voice/timings` and `master/voice-timings.json` in the state folder.

## [1.71.0] - 2026-09-29

### Fixed
- **A long spoken request no longer loses its end.** ElevenLabs' speech-to-text commits what it heard by itself after about 36 seconds of audio, and the master's voice chat took that first part as the whole request: everything said after it was dropped. Now every part is kept and the request goes once all of it is written down.
  - The page commits parts itself at pauses (and before 36 seconds of unbroken speech), so a part rarely ends mid-word.
  - What is shown and judged while you speak is the whole utterance, not only its latest part.
  - If the last part is slow to come back, what was written down so far is sent instead of nothing.
  - One utterance may run three minutes (was one), pauses included. Each still reserves its full length against the daily voice limit until it is settled.

### Removed
- **"계속 말씀하세요, 듣고 있어요." in a long pause.** Its own sound came back through the microphone and was written into the request ("…계속 말씀하세…"). A long pause still shows that the master is waiting and, after 20 seconds, keeps what was said unsent, as before.

## [1.70.0] - 2026-09-29

### Changed
- **A skill copied into each agent's folder is listed once.** Skills installed earlier as separate folders in `~/.agents/skills` (Codex) and `~/.claude/skills` (Claude Code) showed twice in the skills panel, one row per agent, while skills made in Tower showed once with both labels. Now each skill is one row with the agents that use it.
  - Identical copies show **복사본 N개** and a **합치기** button: the other copies move to `<state>/skills-trash` and a link to the kept folder takes their place, so an edit reaches both agents. A pin on any copy is kept.
  - Copies that differ slightly (usually each names its own agent) show **에이전트별 복사본** and are not merged; editing one says which agent's copy changes.
  - Deleting such a skill removes every copy.

## [1.69.0] - 2026-09-29

### Added
- **Skills.** Keep the ways you often work as skills, and Claude Code and Codex handle the same kind of request in the same order without being told again. A new **Skills** button in the header lists every skill on this computer, and **이 폴더의 스킬** in a project folder's menu lists the skills usable in that project: its own and the global ones.
  - Skills are standard `SKILL.md` folders. A global skill is written to `~/.agents/skills` and linked into `~/.claude/skills`, a project skill to the project's `.agents/skills` and `.claude/skills`, so both agents load it by themselves, in Tower and outside it. Skills installed before are listed too, and a skill only one agent had can be linked for the other.
  - **항상 확인** (always check): Tower names a pinned skill at the start of every turn it runs, whether it came from a chat, a trigger, Slack or the master, so a workflow such as "design → cross review → implement → cross review" is followed for every new task. A project's pinned skills are named only in that project.
  - **Proposals**: when a session you worked in has been quiet for 10 minutes, a light model (Claude Sonnet by default, or Codex GPT-5.6 Terra) sums up how you worked, and proposes a skill once the same way of working shows up in two sessions, or at once when you state it as a rule. Review and edit a proposal, add it with one click, or dismiss it for good. **최근 7일 분석** reads the last week at once. The call has no tools and saves no conversation; work started by triggers, Slack, other agents or other computers, and closed sessions, are never read.
  - Deleted skills are moved to `<state>/skills-trash`, and a skill that is a link to another folder only loses its link.
  - Every agent's guidance now says to check the owner's skills before starting a task, and how to save a new one when asked.
  - The master can open the skills panel.

## [1.68.0] - 2026-09-29

### Changed
- **The master's session is no longer shown as a session.** The master's own conversation, its subagents, and its folder (`<state>/master-session`) are left out of the canvas, the session list, project and folder choices, session counts, and what a joined computer shows. You use the master only through its chat on the right and the floating voice controls. Work the master hands to sessions in other folders is shown as before.
  - A master session replaced with **새 마스터 세션** is kept, but it is in the master's folder, so it is not listed either.
  - The master's turns ending no longer send push notifications, since its chat and voice already give its answers. A master turn waiting on you still does.
  - Session lookups (`sessions_list`, `sessions_search`) still find the master's conversations and mark them `master: true`.

## [1.67.0] - 2026-09-29

### Changed
- **Voice goes on with the master's chat closed.** While voice is on, the master's answers and news of finished work are read aloud, and what you say is still written down and sent when you finish, whether or not the master's conversation is open on the right. Before, closing it marked everything as not said aloud. The floating voice controls stay as they are, and reopening the conversation plays nothing twice.

## [1.66.0] - 2026-09-29

### Added
- **Hear a voice before choosing it.** The master's **Voice** setting is now a list of the voices your ElevenLabs account can use, each with a play button. It reads a short Korean sample in that voice, with the reading model and bright tone set now. Choosing a voice saves it at once, and spoken answers and reports of finished work are read in it. The voice you already chose stays chosen.
  - A sample is made once per voice and model and kept in `<state>/master/voice-previews` (at most 60, 5 MB), apart from the recorded short replies. It counts toward the daily voice limit like anything else read aloud.
  - Voices can be listed and heard with only an ElevenLabs key saved, before the master session starts.

### Fixed
- A recorded short reply that took too long to make now stops its request to ElevenLabs instead of letting it run on.

## [1.65.1] - 2026-09-28

### Changed
- **Fully automatic Slack replies say so.** A reply sent by a rule with **Auto-reply with the result without approval** has a small grey line under it: `Sent by <your Slack name>'s agent`. A reply you asked for in chat, or approved, has no such line and reads as your own.

## [1.65.0] - 2026-09-28

### Changed
- **The master is a Claude Code or Codex session.** The master no longer talks through a model API with a key. It is an ordinary session that Tower keeps in its own folder, `<state>/master-session`, and it runs on your Claude or ChatGPT subscription sign-in like every other Tower session.
  - The button at the bottom left opens its conversation in the usual chat panel. The first time, a small panel asks which tool to use and takes the first message.
  - Models and reasoning are chosen in the chat, as in any session. **새 마스터 세션** in its settings starts a new one, for example with the other tool. The old one stays as an ordinary session.
  - The master has every tool its CLI has. Tower also gives it the master's own tools:
    - `tower_api`: everything Tower's pages can do;
    - `tower_query`: fast read-only lookups;
    - `session_read`;
    - `ui`: the screen of the tab showing the master;
    - `terminal_read`;
    - Tower's own tools, such as Auto Prompt.
  - A guide in its folder (`CLAUDE.md`, `AGENTS.md`) asks it to hand project work to other sessions.
- **Handed-out work is reported to the master.**
  - Tower follows the work the master hands out, whether through Auto Prompt or by starting a session or sending a message. When it ends, Tower sends the master a `[Tower report]` message with the result, and the master tells you.
  - Reports go in messages of bounded size, each named by an ID. A report whose sending was cut off is looked for in the master's conversation and sent again only when it is surely missing.
- **Voice works with the session.** What you say goes to the master session, and its answer is read aloud as before. Messages that land in the same turn are answered once. Jev still judges when you have finished speaking.
- **Never an API key for the conversation.**
  - Master turns run without API-key environment variables.
  - Claude Code must report a claude.ai sign-in with Anthropic's own service.
  - Codex runs with ChatGPT sign-in only, and its thread must be on OpenAI's own service. The Codex desktop app's own sign-in is not used.
  - Otherwise nothing is sent, and the turn says why.
  - An execution worker from before this release does not take the master; the master waits until the worker has changed over.

### Removed
- The master's model API connection: OpenAI Responses, and the Claude models over an Anthropic API key added in 1.63.0.
  - The OpenAI and Anthropic key settings go too, and the saved key files are deleted.
  - The `@anthropic-ai/sdk` dependency is removed.
  - The master's own conversation list, message box, per-message model row, secret and push cards, and optional limits are gone.
  - The conversation kept before this release stays on disk, unchanged.

## [1.64.0] - 2026-09-28

### Changed
- **The master reads its whole answer aloud.** An answer to a spoken request used to be cut to its first paragraph (at most 300 characters), so a second paragraph, a list, or the joke itself after "좋아요, 하나 해볼게요!" was shown but not said. Now the whole answer is read, in order. Headings, list items and table rows are read as sentences, a link by its words, and markdown marks are left out. A code block is pointed to ("코드는 화면에 있어요"), and a web address is read as "링크". Reports of finished work that are read aloud are read whole too. The master is told its whole answer will be heard, so it writes short spoken sentences with the point first. The tone tag still sets only how it sounds: it goes to speech, never on screen, and is given to each part.
- **Long answers are made in parts that play as one.** The answer is split between whole sentences: a short first part so the sound starts soon, then parts of up to 500 characters, each made after the one before and played as a single recording, with nothing repeated or skipped between them. A part that fails before any sound comes, or comes back silent, is asked for once more. An answer skipped, cut off by voice ending, or not started in time stops being made: parts not yet asked for are not asked for or paid for. Reading ends at a sentence after about 5,000 characters (some ten minutes), followed by "나머지는 화면에 있어요."

### Fixed
- **A page that asked for audio after it failed got none of it.** The connection was cut before what was already made had been sent. It now receives that part before the connection is cut. This was also why the "audio streams to the page" test failed now and then.

## [1.63.0] - 2026-09-28

### Added
- **The master can answer with Claude Opus.** The model list in the master settings, and the model row above the message box, now offer **Claude Opus 5** (`claude-opus-5`) and **Claude Opus 5.5** (`claude-opus-5-5`) next to the GPT models. Claude models are asked through the Anthropic API with an **Anthropic API key** from platform.claude.com, entered in its own field in the settings. It is kept in its own owner-only file on this computer, shown only by its last four characters, and never sent to the model. A Claude Code sign-in (subscription) cannot be used for this. Claude thinks adaptively; the reasoning setting becomes its effort (none and low are low, medium, high), and its tools, pictures and PDFs work as with GPT.

### Changed
- The OpenAI key is now used for GPT models only, and the two keys are saved and removed separately. The conversation stays open when either key is saved: if the key for the settings' model is missing, the settings say which key to add, a message can still choose a model whose key is saved, and a message sent to a model without its key is marked as not answered at once, with the reason, instead of waiting. News of finished work still waits until the key is there.

## [1.62.2] - 2026-09-28

### Fixed
- **Past its judgments, a spoken request neither waits forever nor goes mid-thought.** In 1.62.1 a request whose last judgment came at a pause of three seconds or more could still wait twenty seconds and be kept unsent, and one Jev had judged unfinished (…고쳐 주고 그리고) went at three seconds once the 20 judgments were used. Now, past them, a request goes at a pause of three seconds when its last judgment was near the bar (0.3 or more), and words said since then go at three seconds plus the wait for how they end. A request judged clearly unfinished, or trailing off since, waits for you as before: **계속 말씀하세요**, and after twenty seconds kept unsent.
- **Jev no longer takes a bare 그리고 after a request as the end.** 1.62.1 told Jev that what follows a request finishes it; now only a reason or purpose does ("…해 줄래? 그래서 신나게 말할 수 있도록."), while a joining word left at the end ("…고쳐 줘. 그리고") or another task being added ("…고쳐 줘, 테스트도 넣고") is not finished. Measured against Jev on 27 sentences (11 finished requests, 16 unfinished): one wrong, a finished request at 0.59 that goes at the next judgment (0.62); 1.62.0's wording got four wrong, among them the request that was not sent.
- **Speaking softly uses fewer judgments.** When the microphone misses quiet speech that is still being written down, its pauses are judged once they pass two seconds, not at each new word.
- **"계속 말씀하세요" is not said over you.** When you went on speaking softly, the sign already asked for could play anyway, and one playing went on. Now one on its way is dropped, and one still playing when more of what you said is written down stops, with what the microphone heard while it played written down with the rest.
- **Typing is not taken for speech, and a click does not flash 듣고 있어요.** Speech starts only when most of its first 0.24 seconds is sound, so keys typed quickly do not open a transcription, and the voice bar shows a voice once it has sounded for 0.12 seconds.

## [1.62.1] - 2026-09-28

### Fixed
- **A finished spoken request is sent.** A long request with many pauses could be kept unsent: each pause was judged, the last judgment allowed for one request landed on the finished request just under the bar, and with none left to ask as the pause grew, it waited twenty seconds and was kept unsent. Out of judgments, the pause and how the sentence ends now decide, as when Jev is unavailable, and a request may have up to 20 judgments. Jev is also told that fillers earlier in speech (그, 어, 음) say nothing about the end, and that a reason or purpose said after a request ("…해 줄래? 그래서 신나게 말할 수 있도록.") finishes it. Held-out sentences measured against Jev: 14 of 14 right, against 12 before; mid-thought ones still score 0.03–0.21.
- **Speaking softly is not a long pause.** When the microphone missed quiet speech but more words were still being written down, the pause kept growing: the words were judged as after a pause of several seconds, and "계속 말씀하세요" could play while you were talking. New words well into a pause now start it over.
- **The first words are heard.** Speech used to count only after 0.28 seconds of unbroken sound, so syllables with short gaps between them started it late, and the 0.6 seconds kept from before could miss the first words. Short gaps between syllables no longer start the count over, the count is 0.24 seconds, and one second from before is kept. The voice bar shows **듣고 있어요** as soon as a voice is heard. Speaking when no transcription token was ready (after one failed to load) used to lose the whole utterance; it now waits for a new token.

## [1.62.0] - 2026-09-28

### Changed
- **The master's voice sounds brighter.** Answers, reports of finished work and short replies are read with an ElevenLabs v3 audio tag in front: `[cheerfully]` for most, and `[excited]` for clear good news such as finished work or a deploy that went out. On the Yuna voice, `[excited]` raised the pitch about 1.6 semitones and read a little faster. The tag goes only to speech. It never appears on screen or in the conversation, and it is not read aloud. Failures, warnings, apologies, deletions, security matters and the sentence read before an irreversible change keep the voice's plain tone. The flash v2.5 model does not follow tags, so with it answers are read as before, and the settings say so.
- Square brackets in an answer, such as `[WIP]`, are read as words and no longer taken as reading directions.

## [1.61.0] - 2026-09-28

### Added
- **Send the master any file.** The attach button, paste and drop now take any file, not only pictures. Pictures and PDFs are read by the model itself. Short text files (code, logs, configs, Markdown, JSON and the like, up to 100 KB) reach it as their text, with keys hidden like anything you type. Other files are kept on this computer, so the master can hand them to a session by their path. Sent files show in the conversation: pictures as thumbnails, other files as links to download.
- **Choose the model and reasoning for a message.** A row above the message box sets the model and reasoning for what you send next, instead of the ones in the settings. The choice stays for later messages until you press **설정대로**. A message with its own choice gets a turn of its own and shows what it used.
- **Send a request again.** A request that failed, or that you stopped, is marked under your message with **다시 보내기** and **고쳐 쓰기**. Send again posts it as a new message with the same text, files and choices, once however often it is pressed. Edit puts it back in the message box to change first.

### Changed
- **The draft stays.** What you are writing to the master, with its files and choices, stays when you close the panel and open it again; the text and choices also stay after reloading the tab.
- **Long messages fold.** Very long requests and answers in the master conversation show their start with **더 보기**.

## [1.60.1] - 2026-09-28

### Fixed
- **An update reaches the master without waiting for delegated work.** After an update, the master kept running its old version for as long as any work it had handed to a session was still going, which could take hours. Until then the master panel's microphone stayed off with **마스터가 업데이트를 기다리는 중입니다**, and pictures waited. Work handed to a session runs in that session and is kept in the master's records, so the new version now takes over as soon as the master is not in the middle of answering. It goes on watching that work and reports when it ends, as before. An idle master with work still out keeps running to watch it, as before.

## [1.60.0] - 2026-09-28

### Changed
- **Voice waits until you have finished speaking.** A short pause used to end what you said: after one second of silence the request was sent and the master answered ("네, 확인해 볼게요"), even when you were only thinking of the next words. Now each pause is judged by the fast-judgment service (Jev), from what was written down so far and how long you paused, and the request goes only once you seem finished. It is asked halfway to the pause already, so a finished request still goes about as quickly as before, and it is asked again when you say more or the pause grows. While you pause mid-thought, the voice bar shows **듣고 있어요 · 이어서 말씀하세요**, and whatever you say next continues the same request.
- **A long pause gets a short "go on".** After about five seconds of silence in the middle of a request, the master says once "계속 말씀하세요, 듣고 있어요." It sends nothing and ends nothing, and it stops at once if you start speaking over it. After twenty seconds what you said is written down but kept unsent: speaking again goes on from it, and **보내기** sends it or **지우기** drops it. **보내기** also sends what you are saying right away, without waiting for the pause.
- **Without Jev, the sentence ending decides.** With no Jev key, the **음성으로 말할 때 말이 끝났는지 판단** feature turned off in fast judgments, or Jev failing or taking over three seconds, voice waits a little longer after sentences that trail off (a filler such as 음 or 그리고, a joining ending such as -고 or -는데, or a particle) than after finished ones. Each pause's judgment is listed under the fast-judgment panel's recent judgments. Judgments are limited to 12 per request and 40 a minute.

## [1.59.1] - 2026-09-28

### Fixed
- **The canvas opens already fitted.** After opening or reloading Tower, the canvas used to show the graph off-center until you pressed **전체 맞춤**: the first fit ran before every card was drawn and used a different margin, and a manually arranged canvas never refit once the sessions arrived. The canvas now appears only once it shows the whole graph, with the same view as **전체 맞춤**. Until you pan, zoom or drag something, it keeps fitting as sessions load and as the window or side panels change size. Once you move the view yourself, it stays where you put it.

## [1.59.0] - 2026-09-28

### Added
- **Send pictures to the master.** The master panel now takes pictures (PNG, JPEG, GIF, WebP) like a session's chat does: choose them with the picture button, paste them into the message box, or drop them on the panel. They show as thumbnails before sending and can be removed; a message can be pictures alone. The master sees the pictures together with your message, and they stay in the conversation as thumbnails you can open. Later messages mention earlier pictures by name without sending them again, and the master can hand a picture to a session on this computer by its saved path. Other kinds of files are refused, and while an older master is still finishing work after an update, pictures wait until the new one takes over rather than being dropped.

### Fixed
- **Voice no longer crowds what it heard.** While voice is on, what the master heard or is reading aloud has a line of its own, up to three lines with the latest words in view. Today's use sits on the line below, left of the buttons, so the two never overlap on a narrow screen or with long speech.

## [1.58.6] - 2026-09-28

### Fixed
- **The master conversation opens on its latest message.** Opening the master panel often left the conversation at the top or partway up, because it only followed new messages when it already happened to be near the end, and the panel starts at the top. It now opens at the latest message and stays there while messages arrive, replies stream in, and text and cards finish laying out. Once you scroll up to read, new messages no longer pull you down; scrolling back to the end, or sending a message, follows the latest again. **Show earlier** keeps the message you were looking at in place instead of jumping to the oldest one.

## [1.58.5] - 2026-09-28

### Changed
- **The usage donut marks elapsed time the same way as the details.** The grey inner ring is gone. A small triangle outside the donut points at how much of the period has passed, with a short line across the ring at that point, in a muted shade just darker than the empty ring so it stays in the background.

## [1.58.4] - 2026-09-28

### Changed
- **Elapsed time in the usage details is a marker.** The thin grey line along the bottom of each usage bar is gone. A small triangle above the bar now points at how much of the period has passed, with a single line through the bar at that point.

## [1.58.3] - 2026-09-28

### Added
- **The execution worker's version shows when you point at this computer's version.** On the canvas, hovering **이 컴퓨터 · v…** now shows both versions, for example "화면 v1.58.3 · 실행 워커 v1.53.2". Features the worker runs, such as Slack follow-ups, apply only once the worker reaches the page's version.

## [1.58.2] - 2026-09-28

### Changed
- **Elapsed time on usage meters is quieter.** On the donut, the elapsed-time ring now sits directly against the inside of the usage ring, 2px thick and a softer grey. In the details shown on hover, each limit is one bar again: usage is the bar, and elapsed time is a thin grey line along its bottom edge, with the exact share shown when you point at it.

## [1.58.1] - 2026-09-28

### Changed
- **A sent reply is marked with a green arrow instead of a green border.** In the trigger monitor, a Slack mention Tower had replied to, and every finished trigger run, got a green border that looked like a session at work. The border is gone. A mention whose reply was sent to Slack now shows a green arrow to the right of its title, on the canvas and in the monitor's mention list. Finished trigger runs keep their plain card and the 완료 label.

## [1.58.0] - 2026-09-28

### Changed
- **Voice now works like SORI: what you say is written down, and answers are read aloud (ElevenLabs).** GPT-Live is gone. Voice costs about a tenth as much, and you are billed only while you speak and while the master reads. Add an ElevenLabs API key under **마스터 설정 → 음성**, then press the microphone by the message box.
  - Your page listens for speech and writes it down with ElevenLabs as you speak. Your ElevenLabs key never leaves this computer: the page gets a single-use token for each thing you say. A short recorded reply ("네, 확인해 볼게요.") plays at once, and the master's answer is read aloud when it is ready.
  - While something is read aloud the microphone rests, so the reading never becomes a request. **멈춤** stops a reading. If the browser will not play a reading by itself, **듣기** plays it.
  - Listening turns off after 5 minutes without a request (a setting). Voice stays on in that tab: news of finished work is read aloud while the master panel is open, and listening turns back on so you can answer.
  - Before something that cannot be undone, the sentence is read aloud first. The change goes only if the whole sentence played and you did not speak or press **취소** in the moment after.
  - Today's estimated cost is always shown. A daily limit in dollars is optional; every reading and every utterance is counted against it before it starts.
  - Settings: voice (from your ElevenLabs account), reading model, the pause that ends what you say, listening time, reading reports aloud, daily limit.
  - Voice time from the earlier GPT-Live calls is kept in the day's cost.

### Fixed
- A voice request's answer, stop or failure, and reports of finished work, are marked on screen when they could not be read aloud.

## [1.57.0] - 2026-09-28

### Added
- **Usage meters show how much of each limit's period has passed.** A thin, lighter inner ring on each usage donut shows how far the current window has run: the share of the five hours, or of the week, already elapsed, worked out from the window's length and its reset time. When usage runs ahead of the elapsed time, the usage ring turns red, so you can tell at a glance whether your pace is safe. The details shown on hover now draw each limit as two horizontal bars, usage and elapsed time, with the reset time beside the limit's name.

## [1.56.0] - 2026-09-28

### Changed
- **Sessions in a folder line up in a grid.** Cards are no longer placed one by one. A folder shows its sessions most recent first, one per row by default: they stack from the top down. With two per row, the first two sit side by side and the third starts the next row at the left, and so on. Each folder keeps its own choice of one to four per row, in this browser. In **수동 배치**, folders are still dragged into place; the cards follow their folder. When a folder grows, from more sessions or more per row, the folders it would now cover move right or down out of its way. Saved layouts keep each folder where it was drawn; hand-placed card positions are dropped.
- **A folder's header shows only pinning and a settings button.** The settings button opens a menu with a new session in the folder, the browser code editor and terminal, the group title, hiding the folder, and how many sessions go in a row. The drag grip is gone; the header itself is still the handle.

## [1.55.4] - 2026-09-28

### Fixed
- **Slack conversations read messages posted by integrations.** Apps such as GitHub post their whole message as an attachment and leave the message text empty. Tower read only the text, so a mention under a GitHub "Pull request opened" message saw an empty first message and had to search for the pull request on its own. The thread a conversation reads now includes each message's attachments: the pretext, title with its link, text, fields and footer.

## [1.55.3] - 2026-09-28

### Fixed
- **Links in Slack replies are clickable again.** Replies are sent without Slack formatting, so a URL in them, such as the pull request comment a review reply points to, showed as plain text. Web links in a reply are now sent as Slack links. Mentions and everything else stay escaped as before.

## [1.55.2] - 2026-09-28

### Fixed
- **Turns no longer start without their tools while Tower is rebuilt.** Building Tower emptied `dist/server` before compiling it again, and every turn starts its tool servers (Slack conversation tools, session lookups, Tower's tools) from that folder. A Slack conversation that started during the 1.55.1 build found `tower_slack` and `tower_sessions` unavailable and could not act. The build now compiles into a separate folder and replaces the files one by one, so no file is ever missing, and a failed build leaves the previous one in place. A turn whose tool server script is missing also waits up to two minutes for it; turns that require those tools fail instead of starting without them.

## [1.55.1] - 2026-09-28

### Changed
- **This computer shows its Tower version too.** On the canvas, this computer's card now reads **이 컴퓨터 · v1.55.1**, the way a joined computer's card shows its version beside **연결됨**.

## [1.55.0] - 2026-09-28

### Added
- **Later messages in a Slack thread continue its conversation.** After a mention started a Slack conversation, a new message in the same thread no longer needs to mention you. A fast judgment reads the first request, the latest thread messages and the new one. When the message asks you something, asks for follow-up work, or needs you to step in, it goes to the conversation that handled the thread, as a new turn once that conversation is idle. The conversation then decides what to do. It can delegate the follow-up under the same rule and build on what it already found. Thanks, acknowledgements and messages for other people stay out. A new mention in the same thread also continues that conversation instead of starting another one. This covers threads active in the last 14 days, and your own messages are never followed.
- **Rules with automatic replies report on follow-up work too.** When the first result was already sent, work delegated for a follow-up gets its own result reply under **승인 없이 결과 자동 답변**, as a new mention would.
- **See what happened to each later message.** The mention details in the trigger monitor list them under **스레드 후속 메시지**, with the judged chance each was for you and whether it reached the conversation. Turn the feature off under 빠른 판단 with **Slack 스레드 후속 메시지 이어받기**. Without a fast-judgment key, only mentions are followed.

## [1.54.0] - 2026-09-28

### Added
- **Review pull requests that ask for your review.** GitHub triggers can now watch **나에게 리뷰를 요청한 풀 리퀘스트**. A pull request runs when you are added as a reviewer, when a draft that asks for you is marked ready for review, and again when your review is requested again after you reviewed. Requests already there when the trigger starts do not run. With a coordinator, the conversation reads the pull request's branches, earlier reviews and line comments. What it sends or proposes is posted as a review of the pull request, not as an issue comment. Choosing this watch sets overlapping runs to run in parallel, so one review does not hold back the next.
- **Choose what reviews may decide and whose requests count.** Under **고급 설정**, **리뷰 판정** posts comment reviews only (the default), or also allows **Approve** and **Request changes**. With these allowed, a first line `Verdict: approve` or `Verdict: request changes` decides the review. **내가 속한 팀으로 온 리뷰 요청도 포함** adds requests made to your teams. Whether reviews are posted without your approval is still set per rule by **승인 없이 결과 자동 답변**.

## [1.53.2] - 2026-09-28

### Fixed
- **The master finishes what it is writing before it closes.** When its process stepped aside, a turn or a check of finished work could still be saving the conversation. Closing now waits for both, and neither starts again once it has begun.

## [1.53.1] - 2026-09-28

### Fixed
- **The chat header shows one status, lined up.** A finished conversation showed both **완료** and its outcome, such as **작업 완료**. The outcome now takes the status's place, at the same size. The folder name follows it directly, and the file and terminal buttons stay at the right, instead of the three being spread across the row.

## [1.53.0] - 2026-09-28

### Added
- **Mark a conversation as looked at.** The chat header now shows how the conversation's last turn ended, next to its status. When it shows **확인 필요** or **작업 끊김**, click it (**확인했음**) after you have read the conversation and found nothing left to do. It then shows **작업 완료**, on the canvas card too, and drops out of the master's list of what needs you. A new turn in the conversation is judged again as usual. This works for conversations on joined computers too, once they run this version.

## [1.52.1] - 2026-09-28

### Fixed
- **A voice call that goes quiet is woken again by news.** While a call ran, the page's reports of what it heard used up its 30 changes a minute, so the page's own "end on silence" was refused. The call was recorded as dropped, and news could not wake it. A call's reports and its ending now have budgets of their own. The page reports the moment you start speaking and otherwise every two seconds, and tries its ending twice.
- **An announced irreversible change waits for fresh word from your page.** It goes only after your page reports, after the sentence has played, that you did not speak. A report that did not get through can no longer let it go.

## [1.52.0] - 2026-09-28

### Added
- **Talk to the master.** The microphone button by the master's message box starts a voice call (OpenAI GPT-Live, about $0.05 a minute, on the master's OpenAI key). Say what you want: the master does it as if you had typed it, and tells you how it went. Long answers stay on the screen and the voice gives the gist. What you and the master say appears in the conversation as it is spoken.
  - The call ends after 15 seconds in which nobody speaks and nothing plays, and **다시 시작** starts it again at once. The seconds are a setting; 0 keeps the call open.
  - If the call ended that way and news for you arrives, such as delegated work finishing, the voice turns itself back on and tells you. This happens only while the master panel is open and in view, and once for each piece of news. News that could not be told within an hour is marked on the screen instead.
  - Before something that cannot be undone (closing a session, cancelling work, deleting, sending out), your browser says in one sentence what is about to happen. The change goes only if the sentence played to the end and you said nothing until it was sent. If you speak, it is not sent, and what you said becomes your next request.
  - Today's voice time and cost always show under the conversation and in the settings. A daily limit is optional.
  - The OpenAI key stays on this computer: the master makes and follows the call, and your browser only carries the sound. Secrets are never taken by voice; the master offers a card instead. A card's value is hidden in the transcript too, even when it is said across a pause.
  - Voice needs a microphone and an https address or this computer (localhost). Ending a call never stops work the master started.

### Changed
- **The master reads the conversation in its own roles.** Your messages are yours, its answers are its own, and everything else (calls, finished work, cards, what you are looking at, Tower's status) is marked as data. Only Tower's own words are instructions.

## [1.51.1] - 2026-09-28

### Changed
- **Related sessions are judged by what you asked in them.** Each earlier session is now described by its title and its latest requests from you, newest first. There are up to eight, 300 characters each, and as many are sent as fit its share. The agent's last answer is no longer sent. Requests say what a session is about, even when its work moved on from the first one.

## [1.51.0] - 2026-09-28

### Added
- **New conversations hear of related earlier sessions.** When a conversation starts, from Tower, Auto Prompt, a trigger or Slack, a fast judgment looks at the titles and last messages of the 40 most recent sessions, starting with the same folder. It tells the agent which ones look like the same work: the same issue, customer, incident, pull request or error. The agent gets their ids in a note only it sees, and decides itself whether to read them. The conversation shows nothing extra. It never delays a turn by more than a few seconds and is skipped whenever the judgment is unavailable. Turn it off under **빠른 판단 → 새 세션에 관련 세션 알려주기**.

### Changed
- **Slack and GitHub conversations are readable.** The coordinator's policy, your rules and the tone guide no longer fill the conversation. It shows the request with its thread, a delegated task's result, and what you typed, exactly as written. Tower's instructions and receipts still reach the agent as a separate block the conversation leaves out. They are kept only in the worker's memory: pages and saved state never hold them. A continuation that needed them is not started without them after a restart.

## [1.50.0] - 2026-09-28

### Added
- **The master works your screen.** Ask it to open or close a conversation, open a panel (the session list, help, the new-session dialog with the folder and request filled in, the Auto Prompt dialog on a folder or computer, triggers, joined computers, quick judgments, notifications, account), set the sidebar's search and filters, or change the language or chat text size. The tab you wrote from does it with the page's own controls and tells the master whether it could; account management opens only on a page of this computer itself. With **찾은 세션을 내 화면에 열기** off, the master offers a button in the conversation instead.
- **Cards for what only your browser can do.** The master can show a card that turns on notifications on the device where you press it, and a card for typing a password, token or key. A value typed into a card stays in memory only: the master sees a reference and can put the value only into that request's secret field (a Slack token, a fast-judgment key, a password, a saved header's value, a join code). From then on, wherever the value appears whole, it is hidden in everything the master reads, keeps or shows, whatever the key-hiding setting. A card takes values of 8 characters or more that are not words of the master's own instructions.
- **The master reads terminals**: it can look at a terminal's recent output, with keys hidden.

### Changed
- Keys are recognised after `_` or `=` too (as in `OPENAI_KEY_sk-…`), in answers' field names as well as values, and before anything is shortened. A reference to a key now goes back only into the exact field of the request that takes that secret; a reference anywhere else, such as a title or a prompt, is refused.

## [1.49.0] - 2026-09-28

### Added
- **Agents look for earlier work before redoing it.** Tower's agent guidance, which every Claude Code and Codex session here receives, now says when to search earlier sessions: a follow-up, a trigger or Slack report about a known issue, the same game, customer, incident, pull request or error. It says to search with a few distinctive words, read what was concluded, check that it still holds, and name the session it came from. Self-contained tasks skip the lookup. The Slack coordinator checks for earlier work before delegating and passes the related session ids and findings to the project agent, so it builds on them instead of starting over.

### Fixed
- **Session lookups find Slack work after it is done.** They searched only what the canvas shows, which leaves out Slack coordinator conversations and the work they delegated once it finishes. That was often exactly the earlier investigation an agent needed. They now search every conversation on this computer. A controlling computer still sees only what it saw before.

## [1.48.0] - 2026-09-28

### Added
- **Every turn Tower runs can look up earlier sessions**, not only the ones you start: trigger, Slack, GitHub, Auto Prompt work started by agents, and conversations holding outside content get `sessions_list`, `sessions_read` and `sessions_search` too, from a `tower_sessions` tool server. They read nothing an agent's shell could not. Its key is kept owner-only in Tower's state directory and opens only these three read-only lookups. Work started from a controlling computer keeps to what that computer may see, through Tower's tools as before.
- A session can be named by its bare Claude or Codex session UUID (as `claude --resume` or Codex shows it), in `sessions_read` and in a search's `sessionId`.

## [1.47.0] - 2026-09-28

### Added
- **Agents can search earlier sessions.** The new `sessions_search` tool finds conversations whose messages contain every word of a query, case-insensitively, optionally within a period (`since`/`until`, a date alone meaning that whole day), a folder, a provider or one session. It returns the most recently active first, with the number of matches and excerpts of the latest ones. Tool calls and their output are searched only on request. One call reads at most about 1 GB or 10 seconds of history; a search that stops early returns a cursor that continues where it stopped, even inside a long conversation. It is read-only, so an agent can use it before starting a task to find related past work and pick up its context.
- **Session lists and conversations come a page at a time.** `sessions_list` returns 20 sessions by default, most recently active first, with a cursor for the next page, and filters by title or folder text and by a period of last activity. `sessions_read` pages back through a conversation with a cursor, and a search match's cursor opens the conversation at that match. Tool calls are left out of a page unless asked for, which keeps answers small.
- These tools are available to agents in turns you start from Tower, and to the master through Tower's API. The master is told to look for related earlier sessions this way. A controlling computer's agents search only conversations that computer may see. If sharing changes during a search, it answers nothing.

### Changed
- `sessions_list` no longer lists runs other agents started (such as `codex exec` reviews), matching the canvas.

## [1.46.2] - 2026-09-28

### Fixed
- **"Stop thinking" now also stops a change that is still waiting for Tower's web server.** While the web restarts, the master holds changes it has not sent yet; after a stop they are no longer sent when the web comes back. A change that never reached a web is recorded as not sent, instead of staying "sending" and later reading as uncertain.
- **Messages and reports are no longer repeated or lost when the master restarts at the wrong moment.** A message sent again after its answer was lost keeps its id, so it runs once. A turn's answer is saved before its message counts as answered, and work the master delegates is saved as watched before the change that started it counts as done. An answer that could not be saved leaves its message open.
- **A turn that failed without changing anything is tried once more** a few seconds later, also across a restart, so a passing model error no longer drops a report of finished work. A model answer that stalls now ends at the turn's two-minute limit.
- **Reports use the right answer.** A longer request in the session that merely begins like the delegated one is no longer taken for it; the same request with Tower's list of attached files still is. Auto Prompts sent through `/api/v1/autoPrompt.submit` are followed and reported too.
- **Secrets are hidden before messages are shortened**, so part of a key at the cut can no longer reach the model.
- **The master starts even after long conversations.** A conversation file over 12 MB no longer stops the master from starting, and delegated work from long ago no longer stays "running" after a restart.
- When Tower starts while a message or delegated work is waiting, it starts the master itself instead of waiting for a page to be opened. The master button retries its first connection.

## [1.46.1] - 2026-09-28

### Fixed
- **The master's lookups need a Node.js with SQLite's authorizer, and are offered only there.** The authorizer is what keeps them read-only, and Node.js 22 has none, so on it every lookup from 1.46.0 failed and cost the master an extra step. On such a Node.js the master now looks things up through Tower's API, as before 1.46.0; the live status summary at the start of each turn works on every version. Lookups work on Node.js 24.10 or newer and in the standalone executables.

## [1.46.0] - 2026-09-27

### Added
- **The master answers quick questions without waiting.** While its room is in use, the master follows the same live updates a page receives, and every turn starts from a short summary of what is working, what waits for you, and what finished in the last 30 minutes. Questions such as "what is running?" are answered from that summary in one step, instead of fetching a whole snapshot that could be cut short.
- **Read-only lookups.** For anything the summary leaves out, the master asks one read-only SQL query over the current sessions, requests, triggers, and joined computers. Queries can only read, return at most 500 rows, and are stopped after 2 seconds; they run in a separate process that also ends if its parent does. Secrets are hidden before anything is shortened or stored.
- A joined computer that has not sent current data yet is named in the summary, so its work is never silently left out. Work the master hands to a conversation is followed on the live updates instead of repeated polling.

## [1.45.1] - 2026-09-27

### Fixed
- **Recover unfinished background work when Claude exits early.** If an owner-started Claude process exits with background results still outstanding, Tower resumes the same conversation after a short delay, asking it to inspect existing output and running work before doing anything again. Recovery is limited to three attempts, saved across worker restarts. An explicit stop, a newer instruction, a pending approval, uncertain instruction delivery, provider-reported failure, or the background wait limit does not trigger recovery. Slack and trigger runs retain their existing lifecycle.
- A result now gets a short drain period before Tower closes Claude's input, so a background-task start arriving just after it can keep the process open. A subagent's result cannot finish its parent, and a repeated result cannot count as having read a background notice.
- Early-exit errors retain the process exit code, signal, and stderr. The run also records whether Tower closed input and how many background results were outstanding, instead of hiding those details behind a generic background-work error.

## [1.45.0] - 2026-09-27

### Added
- **Jev inserts messages into conversations on joined computers too.** A message you send from this computer's page to a running conversation on a joined computer is now judged here, just as for a conversation on this computer. If it belongs to the work in progress, Jev inserts it into that turn over there. The joined computer needs 1.45.0 as well; an older one refuses the insert and the message waits for the turn to end, as before. Messages typed on the joined computer's own page are judged there, and a computer never judges what its controllers send it.

## [1.44.5] - 2026-09-27

### Fixed
- **Inserting a message into a running Claude turn no longer fails while Claude is busy.** Claude takes an inserted message at its next step, after the tool call or reply it is writing. That can be minutes away. Tower gave up after 15 seconds and showed **전달 여부 확인 필요** for a message that Claude took later. Tower now waits while the turn runs and shows **끼워넣는 중** until Claude takes the message. The 15-second limit applies only after the turn has ended. This applies to **지금 끼워넣기** and to Jev's automatic inserts.
- **Messages inserted into a running Claude turn now appear in the conversation.** Claude Code records them differently from ordinary messages, so the chat did not show them.

## [1.44.4] - 2026-09-27

### Changed
- **Unread cards show the same dot as the sidebar.** The green **N** from 1.44.3 is replaced by the blue dot that already marks unread conversations in the session list, still at the card's top left. Hovering it says 새 활동, and screen readers still announce it.

## [1.44.3] - 2026-09-27

### Changed
- **The unread mark is now just a green N.** The top-left badge from 1.44.2 dropped its **새 활동** text and outline, leaving a plain green **N**. Hovering it still says 새 활동, and screen readers still announce it.

## [1.44.2] - 2026-09-27

### Changed
- **Unread conversations are easier to spot on the canvas.** The **새 활동** mark moved from under the outcome badge at a card's top right to its own badge at the top left, led by a red **N**. The outcome badge (**작업 완료** and the others) keeps the top right to itself.

## [1.44.1] - 2026-09-27

### Fixed
- **The master panel starts right under the page header.** On wide screens it began 10 px below the header, leaving a strip of the sidebar showing above it. It now follows the header's actual height. On phones it still opens as a sheet from the bottom.

## [1.44.0] - 2026-09-27

### Added
- **Master agent: tell Tower what to do in plain words.** A round button at the bottom left (or **Shift+M**) opens one conversation with the master agent. It does what Tower's own pages do, through the same routes they use: it looks up sessions and runs, starts sessions and sends them messages, runs Auto Prompt, and changes triggers, folders, git, files, terminals, joined computers, Slack, public agents, notifications and settings. Work it hands to a session is tracked, and when that session finishes the master tells you what came of it. It can also open a session on your screen.
  - Save an OpenAI API key in the panel's settings (gear icon) to turn it on. It uses `gpt-6-luna` with low reasoning by default; both can be changed there.
  - It does whatever you ask, without confirmation steps. Its settings offer optional limits: only report when finished work comes back, computers it may only read from, and a cap on irreversible changes per request. All are off by default.
  - Keys and tokens you paste, or that a page returns, reach Tower as references and never the model (on by default). Account management and Tower updates still need a request typed on this computer, as on Tower's own pages.
  - It runs in its own background process, so restarting or updating Tower's web server does not interrupt it. What it keeps is in `master/` in the state directory.
  - **생각 멈춤** stops its thinking. Changes it already sent finish and are recorded. A change whose outcome is unknown is never sent a second time.
  - Voice conversation (GPT-Live), fast lookups in a read-only database and opening other panels on your screen come in later releases. The design is in [#3](https://github.com/kimwz/agent-session-tower/issues/3).

## [1.43.0] - 2026-09-27

### Changed
- **Conversations that still need something stay on the canvas.** A conversation marked **확인 필요**, **작업 끊김** or **이어서 진행 예정** no longer disappears as it gets older. The sidebar's period filter keeps it, and newer conversations no longer push it off the canvas's card limit. It leaves as before once its last turn is marked **작업 완료**, or when you close it. This applies to conversations already marked, too.

## [1.42.0] - 2026-09-27

### Added
- **Canvas cards show how a finished conversation ended.** Once a conversation stops working, Jev reads its last request and the agent's reply after it and marks the card at the top right: a green **작업 완료** when the work is done, an orange **확인 필요** when the agent asks you to choose, approve, answer or do something, a red **작업 끊김** when it failed or stopped, and a blue **이어서 진행 예정** when it says it carries on by itself. Working conversations look as before.
  - A conversation that ended in an error, or whose last message is yours with no answer, is marked **작업 끊김** without asking Jev.
  - Each turn is judged once, a few seconds after it ends, and remembered across restarts. The mark disappears as soon as the conversation moves on, until its new last turn is judged.
  - Only conversations shown as their own cards that ended in the last three days are judged, at most the 40 most recent.
  - Turn it off under **Fast judgment → 캔버스에 세션 상태 표시**. **Recent judgments** lists each one with its probabilities.

## [1.41.0] - 2026-09-27

### Added
- **Jev decides whether a message sent during work goes in now or waits.** When you send a message to a conversation whose turn is running, Tower asks Jev whether it belongs to the work in progress or is a separate request. Belonging covers correcting, redirecting, stopping, adding a detail or a finishing step such as "then deploy it", and answering the agent. If it belongs, the message is inserted into that turn at once, exactly as **지금 끼워넣기** does. Otherwise it waits until the turn ends, as before. A message is inserted only when Jev is at least 60% sure it belongs, because a wrong insert cannot be taken back. On your own earlier messages and made-up ones, no separate request went above 0.43. The two messages you had inserted by hand scored 0.96 and 0.97.
  - The insert goes only into the turn that was judged. If that turn ended or another began meanwhile, the message keeps waiting.
  - An insert that cannot be confirmed is never sent again.
  - Turn it off under **Fast judgment → 작업 중 보낸 메시지 끼워넣기**. **Recent judgments** shows each decision with its probabilities.
  - It applies to messages sent from this computer's page. Messages to a joined computer's conversations are not judged.
  - It starts working once the execution worker has moved to 1.41.0, which happens by itself when no work is running.

## [1.40.5] - 2026-09-27

### Changed
- **Archive and close are easier to tell apart by touch.** On phones and other touch screens, the conversation header's archive and close buttons are now 36 px instead of 26 px, with larger icons and a 12 px gap between them instead of 2 px, so closing the conversation no longer risks archiving the session.

## [1.40.4] - 2026-09-27

### Fixed
- **Finished turns are pushed again with Notification filtering on.** Jev was asked whether a turn was "an intermediate update … or only one step of a larger task", and whether the owner should be interrupted now. On the owner's 59 most recent finished turns, all worth a push, it called 6 (10%) intermediate and no push was sent. Among them were release reports ending in "배포했습니다". The second question gave about the same low answer for every turn, so it could not tell them apart. Tower now asks one question about the end of the turn's own output, with the marks of tool calls removed: does its last message say the work is not finished and that the agent carries on by itself? A push is skipped only when that is at least 80% likely. On the same 59 turns none are skipped, and the highest answer was 0.50. Made-up replies such as "I'll check back when the build finishes", placed after some narration, all are skipped, and the lowest answer was 0.99.

### Added
- **Recent judgments** in the Fast judgment panel. It lists the last 40 judgments: what each was about, the probabilities the service gave, and how Tower judged it (worth a push, an intermediate step, suggested, nothing fits). The list is kept in memory and starts empty after a restart.

## [1.40.3] - 2026-09-27

### Fixed
- **No more stray "Background work you started… has finished" requests in conversations.** Since 1.39.0, Tower sent Claude this reminder a minute after a turn ended whenever it had not seen Claude take a finished background task's result. Claude Code usually takes that result without showing it back to Tower: inside the turn under way, in a turn it starts by itself, or not at all when the agent already reported by message. Tower therefore reminded Claude of work it had already handled, sometimes several times in one conversation. Claude then answered the reminder, and the reminders appeared as your own messages. Tower now counts a result as taken once Claude starts a turn by itself or its next model reply begins after the task ended. It reminds Claude only when neither happened.
- Tower's reminders, including ones already in conversations, now show as **Background task** notices with the task's status and summary, not as messages you sent.

## [1.40.2] - 2026-09-26

### Fixed
- **The release checks pass on Node 22 again.** The 1.40.0 and 1.40.1 packages were published, but the checks that run after publishing failed on Node 22: a Jev adapter test waited on a fake request that nothing kept alive, so the test process ended early. Tower itself is unchanged from 1.40.1.

## [1.40.1] - 2026-09-26

### Fixed
- **Stopping Tower saves notification state before it exits.** While shutting down, the web waited for pushes still being decided with a timer that did not keep the process alive, so on some Node versions the process could exit before saving which pushes were handled. It now waits the full moment (at most 2 seconds) and saves; pushes still undecided then are taken up again on the next start. This also made the 1.40.0 checks fail on Node 22.
- A check of Codex capability reading no longer fails on a busy machine: it gives the fake Codex CLI up to 8 seconds to start and still times only the abort.

## [1.40.0] - 2026-09-26

### Added
- **Fast judgment (Jev).** A new **Fast judgment** button in the header takes an API key for a fast multiple-choice judgment service. Jev is the first such service. The two features below use it, and each can be turned off on its own. Without a key both stay off and Tower works as before. The key is stored only in this computer's state folder (owner-only file) and is never shown again, only its last four characters. **Check key** sends one made-up question, never your conversations. Features reach the service only through a provider-neutral decision interface (`server/decisions/`), so Jev can later be swapped for a similar API by adding one adapter.
- **Auto Prompt suggests the project and conversation while you write.** Once a request is 30 characters long, Tower asks Jev at most every 5 seconds (only when the text changed) where it belongs. The answer appears under the text box as **Jev 추천 project › conversation**, or **› 새 세션** for a new conversation. Leave the checkbox on and **Send** goes straight to that conversation, or to a new one in that folder, without the usual routing. Turn it off to route as before. A suggestion never carries over to another tool, folder, computer or a new draft, and it does not change while a request is being sent. For a joined computer, Tower asks that computer for what it shares at that moment before sending anything of it. Each suggestion sends the request text plus the titles and last messages of the candidate projects and conversations.
- **Waiting for your approval or answer** is a new notification kind, on by default and also for devices registered earlier. You get a push when a conversation waits for your approval or asks you a question, whoever started the work.

### Changed
- **Fewer pushes for turns that were only a step.** A finished turn is no longer announced when the conversation already continues: when the agent scheduled its own continuation, a message you queued runs next, or you already sent something after it. The final turn is announced as before, and failures always are. Messages inserted into a running turn are announced with that turn.
- With **Notification filtering** on, Jev reads the request and the end of each finished turn. It skips the push only when both of its signals agree the turn is an intermediate step with nothing for you yet. Otherwise the push is titled **Task finished**, **Needs you** or **Blocked**. If the judgment fails or takes longer than 6 seconds, the turn is announced as before.

## [1.39.2] - 2026-09-26

### Fixed
- **Folders on the free-form canvas stay put.** A folder's top-left corner no longer moves when its sessions change. Before, the folder followed its top-left card, so it jumped whenever that card left the view, came back, or a new session was placed to its left. Now the cards shift inside the folder and keep their layout. New sessions are placed only to the right of and below the folder's first card. Dragging a card or a folder by hand works as before.

## [1.39.1] - 2026-09-26

### Fixed
- **Updating or restarting Tower no longer signs you out.** Remote sign-ins are now kept in the state directory, so they last their full 7 days across restarts and updates. Logging out, changing the password or blocking the IP still ends them at once. Only a digest of each sign-in is saved, never the sign-in itself.

## [1.39.0] - 2026-09-26

### Fixed
- **Agents that say "I'll report when it finishes" now do.** When a Claude turn started background work (a command run in the background, a Monitor, or a background agent), Tower used to end the turn at Claude's first answer. That closed Claude's process, so the work was killed or its completion notice was lost, and the conversation looked finished with no result. Tower now keeps the turn open while that work runs. Claude takes each result in a follow-up turn of the same task, and the turn ends after that. While it waits, the conversation shows **Waiting for background work**.
- If Claude has not taken a finished task's result within a minute, Tower hands Claude the notice itself, with the task's summary and output file.
- A message you send while a turn only waits for background work is delivered to that conversation right away instead of waiting in the queue.
- Background work still running after two hours ends the turn, as every turn ended before, and the turn is reported as an error rather than a success. **Stop** ends it at any time. Claude exiting before it took its results is also reported as an error.
- A ScheduleWakeup that fires inside a turn kept open like this is no longer scheduled a second time.

## [1.38.2] - 2026-09-26

### Fixed
- **Sharper installed-app icons.** The PWA manifest no longer advertises the tab favicon's embedded 64px bitmap as a resolution-independent image. Installed apps now receive explicitly sized PNGs up to 1024px, exported directly from the selected original artwork; the Apple touch icon also uses 1024px. Refreshed manifest and icon URLs replace the previous references.

## [1.38.1] - 2026-09-26

### Changed
- **A new rainbow canvas icon for Tower.** The selected rainbow progress frame and canvas panels now identify Tower in the header, browser tab, installed app, and notifications. Icon URLs are refreshed so browsers can replace the previous mark.

## [1.38.0] - 2026-09-26

### Added
- **See generated images in conversations.** Local Markdown image references and image file links now show previews you can open at full size. Codex generated-image paths in tool results appear above collapsed tool activity, including in existing conversations and on joined computers.
- Image delivery uses authenticated, signed conversation references, validates raster file signatures and size, and respects project boundaries and remote folder exclusions. PNG, JPEG, GIF, and WebP files in the session project or Codex generated-image directory are supported.

## [1.37.1] - 2026-09-26

### Fixed
- **Tower opens on the first try behind a login such as Cloudflare Access.** Coming back from that login, or following a link to Tower from another site, showed "다른 사이트에서의 접근은 허용되지 않습니다." until the page was opened again. Opening the page from elsewhere now works; Tower's API still refuses requests from other sites.

## [1.37.0] - 2026-09-26

### Added
- **Push notifications, and Tower as an installable app.** The bell in the header turns on notifications for the device you are using. They arrive even when Tower's page is closed, and clicking one opens the conversation it is about.
  - **What you are told about:** a request you sent from a project chat finished or stopped with an error, with the project, the conversation and the start of the answer; and a trigger started work, with the trigger's name and project. Each device chooses which of the two it receives. It can send itself a test notification.
  - **Nothing is missed during a restart.** Work that ends while Tower's web server is restarting is announced when it comes back, up to an hour later. Nothing is announced twice.
  - **Install it as an app.** Tower can now be installed from the browser, or added to the Home Screen on a phone, and opens in its own window. iPhone and iPad deliver notifications only to Tower added to the Home Screen, so turn them on from there.
  - Notifications need Tower opened over HTTPS, such as through a tunnel, or on localhost. Messages are end-to-end encrypted to each device with keys kept in the state directory. The list of devices is shown in the same panel, where any of them can be removed; a device the browser stops accepting is removed by itself.

## [1.36.1] - 2026-09-26

### Changed
- **Pick a rule's working folder from your project folders.** In GitHub coordinator triggers and Slack automation rules, the working-folder field now lists Tower's project folders as you type, so you can find one by name or path instead of typing the whole path. Leaving it empty still lets Auto Prompt choose, and any other absolute path can still be entered.

## [1.36.0] - 2026-09-25

### Added
- **Public agents: let people outside request work within a scope you set.** In **Triggers → Add trigger → Public agents** you describe what may be requested, choose one project folder and the agent that does the work, and get an unguessable address, optionally protected by a password. Visitors chat with an intake agent that helps them shape one request. When they confirm it, a reviewer checks it against your scope, the work runs in that folder as a new unattended session, and the visitor gets a reviewed summary of the result, for example a published link or a pull request.
  - **The intake agent knows only your scope.** It runs with no tools at all: no files, commands, web or Tower tools. It sees only your scope text and the conversation, so there is nothing internal it could reveal.
  - **Every request is reviewed before it runs.** The reviewer sees only your scope and the final request, never the conversation around it, and anything short of a clear yes is refused. The visitor sees the reason.
  - **Results are reviewed before visitors see them.** The project agent ends its work with a summary for the visitor. A second review removes paths, code, credentials, internal addresses and anything outside the request. The raw output never leaves Tower.
  - **Conversations are shared or per visitor.** You choose whether everyone with the address shares one conversation or each browser gets its own, which visitors can start over. The intake agent's conversation is compacted when it reaches half of its context, so it can go on indefinitely. You can read and reset any conversation from the panel.
  - **They are served apart from Tower.** Public pages have their own port, bound to this computer only, and serve nothing but visitor pages. Publish that port on its own subdomain with a tunnel such as Cloudflare Tunnel, without the login that protects Tower. Tower's pages and API are never reachable on it. Sign-in attempts, new visitors, messages and requests are limited per agent and per visitor address, so one visitor's failed passwords never lock out anyone else or Tower itself.
  - The work runs with automatic approvals and no Tower tools, like trigger runs. It starts only while the agent is on. Changing or removing the password signs every visitor out, and a new address shuts the old one.

## [1.35.0] - 2026-09-25

### Added
- **Hand a repository to an agent from Git sync.** When a folder has uncommitted changes, or its branch has both local and remote commits, the Git sync dialog offers **Hand to an agent**. It opens a new session for that folder with a prepared request: review the changes, commit finished work, bring in the remote's commits, push without force, and report what was done or what needs your decision. You choose the agent and send it. The button is unavailable while an agent is already working in the folder.

## [1.34.3] - 2026-09-25

### Fixed
- **Tower reconnects by itself on a phone.** Coming back to Tower after switching apps or locking the screen reconnects at once, and the open conversation reads the messages it missed. A connection that went silent is replaced within about 40 seconds, and one the browser gave up on, such as during a Tower restart, is tried again with a growing wait instead of staying disconnected until you reload. When the login in front of Tower, such as Cloudflare Access, has expired, the page reloads to go through it. When Tower's own sign-in has ended, the login form appears.

## [1.34.2] - 2026-09-25

### Changed
- **Remote sign-ins last 7 days instead of 12 hours.** Logging out, changing the password, blocking the IP or restarting Tower still ends them sooner.

## [1.34.1] - 2026-09-25

### Fixed
- **Colors and the working-session border on Samsung Internet.** Tower now tells the browser that its pages are already dark. Samsung Internet's dark mode, and other browsers' automatic dark modes, no longer recolor the canvas, and the moving rainbow border around a working session shows again.

## [1.34.0] - 2026-09-25

### Added
- **Serve Tower at an HTTPS address from a tunnel or reverse proxy.** `--public-url https://tower.example.com` lets Tower answer requests for that address, for example from Cloudflare Tunnel, while it keeps listening only on localhost. Visitors from that address see the login page and sign in with the account set in local Account management. Direct localhost access still needs no login. Put the proxy's own login, such as Cloudflare Access, in front of it too. See [behind a reverse proxy or tunnel](docs/usage.md#behind-a-reverse-proxy-or-tunnel).

## [1.33.0] - 2026-09-25

### Added
- **Tower, Claude Code and Codex keep themselves up to date.**
  - **Tower.** Run as the background service, Tower checks for the latest release every 30 minutes and moves to it the way a joined computer's update always has. It installs the release beside the running version, then switches only the web server. If the new version does not come back, the previous one runs again.
    - Running agents and terminals go on through it. The execution worker changes over the next time nothing is running.
    - An update that failed is tried again after 1, 2, 4, 8 and 16 hours, then once a day, and a newer release at once.
    - A computer this Tower controls follows it, and is asked again on the same schedule after a failure instead of waiting for you.
  - **Claude Code and Codex.** Every three hours, a Claude Code or Codex behind its latest release is updated by the Tower on your default state folder:
    - Claude Code's own installer is used for its native install.
    - npm is used for a global npm install. It reinstalls the previous version if the CLI no longer starts afterwards.
    - An update starts only while no run or routing call of that CLI is under way in Tower, and new ones wait for it. A global npm install is also left until no conversation of that CLI is working anywhere, in a terminal included.
    - Other installs are left alone and shown as such.
  - **Where to see it.**
    - The sidebar shows each CLI's version and its update state.
    - **Remote computers** shows the same for joined computers.
    - The header shows a failed Tower update and when it is tried again.
  - **A Tower you started yourself** (a checkout, or npx) does not replace itself. When a newer release is out, the header offers the `service install` command. That command now takes over from the running Tower, restarting only its web server, and afterwards Tower stays current.
  - `TOWER_AUTO_UPDATE=off` turns this off, for development instances.

## [1.32.0] - 2026-09-25

### Added
- **Your message stays at the top of the chat.** While you read the work that followed a message you sent, that message is pinned to the top of the conversation as one line. Click it to read the whole message, or to go back to where you sent it, and fold it again. It gives way when the message itself, or your next one, reaches the top, and it is kept even when a long piece of work has pushed the message beyond what is loaded.

### Changed
- When a background task that Claude Code started ends, Claude Code notes it in the conversation as if you had written it. Tower now shows that note as a background task notice among the agent's work, with its status and summary (a failed task in red), and no longer as your message. This also applies to conversations from a computer or execution worker that has not been updated yet. It no longer counts as your latest request, and it does not make a scheduled continuation think the conversation was continued outside Tower.

## [1.31.0] - 2026-09-24

### Changed
- **Claude and Codex approve automatically in every turn Tower runs for you.** Claude Code runs in its auto mode, where a classifier decides which actions go ahead, and Codex hands approval requests to its automatic reviewer (Approve for me). This covers the chat, new conversations and Auto Prompt, on this computer and on joined computers, so a remote computer no longer stops to ask about each command.
  - The **승인 검토** choice is gone from the new conversation and Auto Prompt windows.
  - It also applies when Tower continues a conversation started elsewhere, and to work your agents start with Tower's tools. A Codex conversation keeps the automatic reviewer for its later turns, including ones in the Codex app.
  - Where the automatic mode is not available, the turn still runs and the chat says so. Approval requests then wait for you as before: in Tower, or in the Codex app for a turn sent to a conversation open there. This happens when Claude Code's auto mode is not offered for the plan or model, or with an older Codex.
  - Triggers and Slack keep their own **승인** setting. A trigger that continues a Codex conversation you have already used from Tower gets that conversation's automatic reviewer.

## [1.30.1] - 2026-09-24

### Fixed
- Auto Prompt failed on every request on computers with Claude Code 2.1.281 or later, reporting "Claude Code returned an unsupported routing event (system/commands_changed)". Newer Claude Code reports status lines during a turn: the slash commands available, whether it is waiting on the model, whether the turn is running, short notices, and a heartbeat. Auto Prompt now accepts these while it chooses a conversation. None of them runs anything or adds to what the model reads. Anything else it does not recognize still stops the choice, as before, and so does a turn that starts compacting its context.

## [1.30.0] - 2026-09-24

### Added
- **Linux computers join with the same one command.** Run the command from **Remote computers → Add a computer** on a Linux computer that has Node.js 22.13 or later. It installs Tower, keeps it running with systemd, and connects to this Tower.
  - Run as root, Tower starts when the computer starts, before anyone logs in. Run as another user, the user has to be allowed to keep services running while logged out; if not, the command prints the one line to run (`sudo loginctl enable-linger <user>`).
  - Restarting or stopping the service stops only the web server. Running agents, approvals and terminals keep going, as on macOS.
  - Joined Linux computers follow this Tower's version and go back to the previous version if the new one does not start, as macOS computers do.
- Each release now includes its built package, and the join command installs it once it is published. The other computer then needs neither Git nor a compiler. Right after a release, until the package is published, the command builds Tower from source as before.

### Changed
- On Linux, opening a Tower page on the same computer skips sign-in only for the account Tower runs as. Other accounts on that computer sign in like anyone else. This matters most when Tower runs as root.
- Joining as root warns when another account can change the Node.js that Tower runs, since Tower runs it as root.

### Fixed
- The join command could end with no message on Linux. Terminals needed a native module compiled on the spot, and without a compiler the install failed silently. Terminals now use prebuilt binaries when the module cannot be built.
- After a computer restarted, Tower could fail to start, reporting that the execution worker was not running. This happened when a process from before the restart had left its lock and its process number now belonged to another program. Such a lock is now recognized as left over.

## [1.29.0] - 2026-09-24

### Added
- **An agent that says it will come back does come back.** When a Claude Code turn started from Tower ends with a scheduled wakeup (`ScheduleWakeup`, for example "I'll check the review again in 20 minutes"), Tower now keeps that schedule and resumes the conversation at that time with the agent's own instruction. Until now the wakeup was lost when the turn's process ended, so the conversation showed as finished and never continued.
  - The canvas card and the conversation list show **HH:MM에 이어서 진행** instead of **완료**, and the chat shows the planned instruction with **예약 취소**.
  - The continuation runs with the same authority, model and effort as the turn that scheduled it. A newer instruction, or activity in the conversation outside Tower, replaces it; the agent can schedule again in its next turn. Closing the conversation cancels it. Slack and trigger turns do not schedule continuations.
  - It is saved, so it survives a Tower restart or a worker update. One missed by more than an hour while Tower was not running is not started.

## [1.28.1] - 2026-09-24

### Fixed
- A joined computer could stay missing from the canvas after it connected, until something changed on it. Its first shared state could arrive before the connection's status and was dropped. It is now kept and shown.

## [1.28.0] - 2026-09-24

### Added
- **See what controlling computers change here.** On a computer joined to another Tower, **이 컴퓨터를 제어하는 Tower** lists the latest changes those computers made there, newest first. Each entry shows which computer made the change, when, and what it changed.
  - Recorded changes: new conversations, messages, titles, closing and reopening, approval answers, steering, cancelling, dismissing, Auto Prompt, repository pulls and pushes, folder names, saved files, new folders, terminals opened and closed, trigger changes, update requests, and joins.
  - Only changes that were made are recorded, and each request is recorded once, even when it is sent again. A change stays in the list even if its folder is kept out of sharing right after.
  - The contents of files and messages, answers to questions, and secret values are never recorded. Conversations are recorded by where they are and shown by their current title, so a first message never ends up in the list.
  - The latest 1,000 changes are kept, and all of them can be read. A computer released since is still named as it was.
- When a computer starts controlling this one, a notice by the header's remote button names it and says when. **보기**, or opening the panel, shows the list. Dismissing it in one tab dismisses it in every tab.

## [1.27.0] - 2026-09-24

### Added
- **Another computer's triggers.** The trigger panel has a computer selector. From this Tower you can list, create, change, turn on or off, run, delete, restore and revert a joined computer's triggers, and they run on that computer.
  - That computer shows only what it shares. Triggers, runs, earlier revisions, deleted triggers and change history that point into a folder it keeps out of sharing, or at a conversation it does not show, look the same as ones that do not exist. A trigger cannot be pointed at them.
  - A change sent from another computer is applied once per request, even when it is sent again. It marks the trigger as set up from that computer. A marked trigger's runs never use a folder kept out of sharing, even one excluded later: this is checked again right before the run is handed over and when the provider starts. A change made on the computer itself removes the mark.
  - While the chosen computer is away or on an older version, the panel stays on that computer and does not save there. A late answer from a computer you switched away from is ignored.
  - Slack, GitHub sign-ins, secrets, limits and HTTP tests are managed only in that computer's own Tower. GitHub coordinator triggers, and the conversations and runs they use, stay on that computer; from here they can only be turned off or deleted.
- **Tower's tools in turns started from another computer.** Turns you start on a joined computer from this Tower get Tower's tools, like turns started there. What the tools see and start is limited to what that computer shares, and work they start remembers who started it.

## [1.26.0] - 2026-09-24

### Added
- **Joined computers keep up with this Tower.** A computer that runs Tower as its background service now moves to this Tower's version by itself, soon after this Tower is updated. Nobody needs to touch that computer.
  - It installs the new version beside the one it runs, checks that it starts, and restarts into it. It keeps the new version only after it has run for a minute without being restarted and has reconnected to this Tower. Otherwise it goes back to the version it ran and restarts that.
  - Running work, approvals and terminals are not interrupted. The part that runs agents stays on the previous version until the update is kept, then moves over at a moment when no work is running. An update cut short, for example because the computer restarted, is checked again when Tower starts there.
  - An update does not start with less than 2 GB of free disk space.
  - **Remote computers** shows each computer's version, where an update stands, and a worker or terminal host still on the previous version.
  - When an update fails, **Remote computers** shows why, and **다시 시도** asks again. A version that failed is not tried again by itself, even after this Tower restarts; an update that keeps being cut short is retried at most twice.
  - It also says why a computer cannot follow this Tower: it does not run Tower as the background service, it runs a version from before this one, or it is newer than this Tower. Low disk space on a computer is shown too.
  - On the canvas, a computer restarting into a new version shows as updating, not offline.
  - Versions no longer in use are removed; the previous one is kept.

### Changed
- The header shows **Worker update pending** only for a worker older than the page, not for a newer one left by an update that was undone.

### Notes
- A computer running a version from before this one needs one update by hand on that computer. After that it follows this Tower.

## [1.25.0] - 2026-09-24

### Added
- **Another computer's files and terminals.** The code editor and terminal buttons on a joined computer's folders, and in its conversations, open that computer's files and a shell running there. The workspace is titled with the computer's name, and the terminal says where commands run.
  - Folders that computer keeps out of sharing, and everything inside them, are left out of its file tree and cannot be opened, saved or used to start a shell from here.
  - A save or a new shell sent again after a lost answer is not repeated: the file is written once, and you get the same shell back.
  - Closing this Tower, reloading the page or losing the link leaves the shells running. Only closing a terminal tab or ending a terminal stops one. A tab that loses its computer offers **다시 연결** and reaches the same shell again.
  - A computer running an older Tower shows why its files and terminals cannot be opened yet.
- **Shared terminals.** **Open terminals** in the terminal bar lists the shells open in that folder that no tab here shows: ones opened on the computer itself, from another window, or by another computer that controls it. Join one to see its output so far and type into it together. Closing a joined tab leaves the shell running for the others. Ending a shell from the list, after a confirmation, stops it for everyone.

### Changed
- Up to six windows can watch the same terminal at once, instead of two.
- When too many terminals are open, the message points to **Open terminals** for ending leftover ones.

### Fixed
- A newly joined computer appears on the canvas right away. Before, its first requests could be refused, and the canvas waited for a retry before showing it.
- A computer removed while it was still joining is told to stop, instead of staying linked.

## [1.24.0] - 2026-09-24

### Added
- **Your joined computers on this canvas.** Each computer joined under **Remote computers** now appears beside this one: its own host node, with its connection state and version, above the folders and sessions it shares. Open a conversation to read it and continue it, answer approvals, stop or steer a request, rename or close a session, sync a folder's branch, and start a new session or an Auto Prompt there. The new-session and Auto Prompt dialogs ask which computer to use.
  - Everything happens on the computer the session belongs to, with that computer's own Claude Code and Codex sign-ins. A request sent again after a lost answer runs only once.
  - A computer that goes offline stays on the canvas, dimmed, showing what it last reported. Its sessions come back up to date when it reconnects, and nothing running there is stopped.
  - Two computers with the same folder or session stay apart everywhere: on the canvas, in the session list, in saved card positions and read marks.
  - With more than one computer, the session list has a computer filter and shows each session's computer.
  - Pinning and hiding another computer's folder is kept on this Tower only. Renaming a folder renames it on that computer.
  - Links in another computer's conversations that point at its own local addresses (localhost, LAN) are shown as text, since they would open something on this computer instead.

### Changed
- Auto Prompt checks the chosen folder before the provider, so a folder it cannot use is reported the same way whether or not Claude Code or Codex is ready.

### Notes
- Opening another computer's files and terminals from this canvas comes in the next release.

## [1.23.0] - 2026-09-24

### Added
- **Join your other computers to this Tower.** Open **Remote computers** (the network icon in the header), turn on **Accept connections from other computers**, and choose **Add a computer**. Run the command it shows once in a terminal on the other computer. That computer installs the same Tower version, keeps it running in the background from each login, and links back to this one. It only dials out, so it opens no port of its own. This Tower opens one link port (8765 by default); its own page stays on localhost.
  - The link is mutually authenticated and pinned to both computers' keys. A code works once and expires after ten minutes. Each computer shows the other's fingerprint.
  - The link comes back by itself after a restart, sleep or network change on either side. A computer that stops answering is marked offline within about 40 seconds. Removing a computer on either side never stops work running there.
  - One computer can be joined to several Towers. The **Towers controlling this computer** tab lists them, and a code can be pasted there too if Tower already runs on that computer. While another Tower is controlling this computer, the header icon shows a dot.
  - The **Sharing** tab manages the folders this computer never shares with the Towers that control it.
- **`agent-session-tower join <code>`** and **`agent-session-tower service install|uninstall|status`** (macOS). The service runs the installed version from `<state>/runtime` with your `PATH`, keeps its log in `<state>/logs/tower.log`, and restarts after a crash.

### Notes
- This release adds the link and its management. Seeing and working with a joined computer's sessions on this canvas comes in the next release.
- The other computer needs Node.js 22.13 or later and Git, and its own Claude Code or Codex sign-in.

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
