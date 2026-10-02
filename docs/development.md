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

### Voice streaming diagnostics

Speech starts from a readable sentence while the master turn is running; completing the turn flushes only its remaining text. The host persists bounded measurements in `<state-dir>/master/voice-timings.json`: run/turn IDs, reply observation times, first sentence flush, per-part TTS start/first byte/completion, say transmission, and page progress. `firstAt` and `completedAt` are native events observed by the worker. `nativeEnd` is the run's completion time; `end` is the voice follower's completion time. Aggregate `delta`/`completed` retain the first values observed in a snapshot; reply records preserve each message's times.

Each bounded TTS part completes before its independent say is sent, so the MP3 response has an exact `Content-Length`. This waits for that part, not the reply or native turn's completion. Parts retain reply order and each requires its own terminal playback ACK. A resumed response advertises the remaining body length. This avoids the unknown-length MP3 startup stall reproduced with WebKit; the page also requires meaningful media-clock progress before reporting playback as started or completed. The normal watchdog and bounded recovery remain in place.

The page reports receipt/queue gate, each source and play attempt, play promise results, media-clock progress, waits, resumes, retries and ended events separately from the terminal playback ACK. Promise resolution or a tiny positive clock value is not evidence of sustained or audible output. A progress report never completes or retries a say. Progress `at` is the host's receipt time and `elapsedMs` uses the page's monotonic clock since receipt of that say. `attempt` distinguishes a replaced source; a late old promise has no snapshot of the new source. A bounded history retains the first 16 events and latest 48, with a drop count, so later progress no longer overwrites the only retry/wait evidence. Terminal ACK receipt and its page elapsed time are recorded during settlement, independently of progress HTTP arrival order. Legacy `play` is an estimate (`say` plus that page delay) and excludes transmission time.

Each generated audio request ID links its live MP3 to host and web relay request/first-write/bytes/end/close measurements, including a resume offset. These are server writes, not browser delivery or decoding times. Normal EOF and a subsequent close are distinguished from a cut stream. Records are bounded and omit speech text, audio, credentials, arbitrary URLs, headers and exception messages. Missing events or dropped history are not evidence of success. The original browser's network/media state and the owner's output device remain necessary to establish audible playback.

For a real media regression without native providers, personal microphones or new TTS calls, supply an existing nonpersonal valid MP3 and an installed Playwright module with WebKit (or select `chromium` or `chrome`):

```sh
VOICE_BROWSER_MP3=/absolute/path/to/fixture.mp3 \
VOICE_BROWSER_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs \
VOICE_BROWSER_ENGINE=webkit VOICE_BROWSER_PCM=1 \
node --import tsx scripts/test-master-voice-stream-browser.ts
```

The isolated browser uses synthetic microphone input and fixture Tower/TTS responses, but real HTMLAudio decoding and optional Web Audio PCM (`VOICE_BROWSER_PCM=0` keeps the raw media path). It verifies finite headers, progress and the first part's ACK while holding the run open, then checks residual flush, deduplication, cancellation and replay. Results are written to `tmp/voice-recovery/finite-browser-<engine>-<raw|pcm>.json`. Optional `VOICE_BROWSER_TTS_DELAY_MS=3000` (integer 0–5000, default 0) sends the second fixture part's first bytes immediately and delays its remaining body and EOF. It measures the synthesis gap, calls public `VoiceSession.listen()` with silent synthetic media during that gap, and verifies that the microphone gate closes for the next audio. Delayed results use a `-delay<ms>` suffix; default checks are unchanged.

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

Every change reaches `main` through a reviewed pull request. A pull request that changes what Tower does carries its release; one that changes only documentation, agent instructions, tests, or CI has none and ships with the next release.

1. On the pull request branch, pick `x.y.z` above the version on `origin/main` (`git show origin/main:package.json`) and write the `## [x.y.z] - YYYY-MM-DD` section at the top of `CHANGELOG.md`, dated today.
2. Run `npm version x.y.z --no-git-tag-version` (`.npmrc` also turns off npm's own commit and tag). It runs `npm run check`, refuses to continue without that changelog section dated today, syncs the version the app reports, and rebuilds. Commit `CHANGELOG.md`, `package.json`, `package-lock.json`, and `shared/app-identity.ts` as `Release x.y.z`, push the branch, and wait for CI to pass.
3. Right before merging, `git fetch` and check:
   - `x.y.z` is above the version on `origin/main`, and `git ls-remote --tags origin vx.y.z` prints nothing. Otherwise, or when the branch conflicts with `main`, merge `origin/main` into the branch (never rebase a pushed branch). In a conflict keep `main`'s changelog sections and versions as they are, move your own section and version above them if needed, and repeat step 2.
   - The changelog section is dated today. Otherwise re-date it and repeat step 2 with `--allow-same-version`.

   A change of version or date alone needs no new review. After any new push, start step 3 again.
4. Merge with `gh pr merge <number> --squash --match-head-commit <head-sha>`. If GitHub refuses it (the branch changed or conflicts with `main`), go back to step 3.
5. `git fetch origin` and take the merged commit from `gh pr view <number> --json mergeCommit -q .mergeCommit.oid`. Check that `git merge-base --is-ancestor <commit> origin/main` succeeds, that `git show <commit>:package.json` has `x.y.z` and `git show <commit>^:package.json` a lower version, and that CI passed on that commit (`gh run list --commit <commit> --workflow CI`; the run can take a few seconds to appear, then wait with `gh run watch <run-id>`). The Release workflow publishes before its own checks and service Towers install the latest release, so never tag a commit whose CI has not passed.
6. `git tag -a vx.y.z -m "Release x.y.z" <commit>` and `git push origin vx.y.z`. The Release workflow publishes the changelog section as the GitHub release notes.

If step 5 fails, do not tag, and never move or force a tag. If another pull request took the version first (the parent is not lower, or the tag exists), open a follow-up pull request that moves the version and changelog section above `main` and release that one; it needs no new review. If CI failed on the merged commit, fix it in a new pull request. Push release tags one to three at a time; GitHub starts no workflow for a push of more than three tags.

To deploy a Tower that runs from this checkout, update the folder it runs from once nobody else is working in it: `git pull --ff-only`, `npm ci` when dependencies changed, `npm run build`, then restart the web process only (see below).

A specific release can be run with `npx --yes github:kimwz/agent-session-tower#vx.y.z`.

A Tower running as the background service moves to the new release by itself within about 30 minutes. It waits up to 15 minutes for the Release workflow to publish the package. To move it at once, ask its own web server: `POST /api/tower/update` with an empty JSON body (the latest release) or `{ "version": "x.y.z" }`, sending the page token from `/api/bootstrap` in `X-Agent-Monitor-Token`. Computers it controls follow it right after.

Development and fixture instances should run with `TOWER_AUTO_UPDATE=off`. Tower from a checkout or npx never replaces itself; only the service does. Claude Code and Codex are updated only by the Tower on the default state directory.


### Web restart and execution worker

Restart the web PID only. Its shutdown closes HTTP streams and authentication sessions, but never sends provider cancellation or termination. The worker owns `runs.json`, `created-sessions.json`, and `auto-prompts.json`; only one worker may write them. Its separate lock is in `<state-dir>/runner-runtime/`. Local RPC uses a short Unix socket in an owner-only `/tmp/tower-runner-<uid>-<hash>/` directory plus a private random credential. This worker transport currently targets POSIX systems.

After the web server stops, running and queued work and approval waits remain live. Restarting with the same state directory reattaches without resubmitting prompts. Mutating RPC requests are not retried after uncertain transport failures. An incompatible worker is never replaced while handling work. The worker exits only after at least 30 seconds without a web client and with no active runs, routing jobs, or terminal shells. Slack monitoring keeps the worker active.

A web process that attaches to a worker from an older build asks it to hand off; a newer worker (left by an update that was undone) is never handed back to an older web. The worker keeps serving, including Slack, until a moment when no run, routing job, Slack task in progress, or shell of its own is active. It then refuses new submissions for that instant, saves its state, records `runner-runtime/handoff.json`, releases its lock, starts the web build's worker, and exits. The web reattaches to that successor only with this record; any other worker change still requires a restart. A submission refused during the switch returns 503 and was not accepted, so it can be sent again. If no quiet moment comes for six hours, new Slack mentions are saved but left for the successor to start; running work is never interrupted. While the attached worker runs a different build from the web page, the header shows **Worker update pending**; features added since that build do not apply until the handoff.

When the worker serves it (capability `forceUpdate`), the header also offers **지금 업데이트** (update now), `POST /api/runner/force-update`. It is the owner's explicit request, so it may stop turns. The worker records the handoff and starts an update drain: no queued turn starts (`pump()` waits beside the provider-update hold), the owner's messages are not inserted into turns waiting on background work, and Slack, triggers, GitHub, public agents and skills hold new work. Every running turn is asked through the normal insert path to wrap up; at the deadline (10 minutes) the turns still running are cancelled. When a turn the update interrupted ends — stopped by the deadline, or ended after its wrap-up request reached it — Tower queues its own continuation (`scheduled.resume: 'update'`, same origin, model, effort and required instructions) in that same step, replacing the agent's own wakeup; it runs before messages queued behind that turn. A turn the owner stops (in Tower or the Codex app), one that fails, and one that completed before any wrap-up reached it end as they are. Delegated work of a Slack or GitHub workflow is neither asked nor resumed: it is cancelled at the deadline with a reason and its coordinator hears the result on the next worker. Codex app submissions that have not started are taken back out of the app's queue. The handoff then waits only for live provider processes, routing jobs and work underway this instant (`transient()`), not for queued turns or workflows waiting on them. Queued turns accepted meanwhile are marked `keepQueued` in `runs.json`, and required instructions of turns still to run are kept in `run-instructions.json` (0600), so the successor restores them instead of cancelling them. A worker starts restored turns only after its tools, gates and limits are set up (`holdUntilReady`, `markReady()`). Trigger and public-agent watchers follow a turn into its update continuation (`continuedRun`). History keeps every unfinished run, runs a workflow still has to report (`retain`), and the newest 100 finished runs. If the handoff still cannot happen 10 minutes after the deadline, the drain ends and queued turns start on the current worker. The master agent follows a delegated run into its continuation. It is refused while a service update is still being verified. Regression checks: `tests/server/runs/runner-update-drain.test.ts` and the forced-update case in `durable-runner.test.ts`.

Owner-started Claude turns with outstanding background results can recover from an unexpected provider exit. Tower queues a continuation in the same conversation after 15 seconds (30 and 45 seconds on subsequent failures), preserving the origin, model and effort. Its persisted `scheduled.backgroundRecoveryAttempt` caps the chain at three retries. Recovery first asks the agent to inspect existing files and processes, rather than repeat the original request. Explicit cancellation, a newer instruction, a pending approval or unacknowledged steer, provider-reported errors, and the two-hour background wait limit do not trigger recovery. The ordinary scheduled-continuation admission checks also apply after a restart. Run output records the exit code/signal, whether Tower closed stdin, and pending-task counts; stderr is retained in the error. Regression checks use fake providers in `tests/server/runs/runner-background-tasks.test.ts`.

Terminal shells run in a separate terminal host (`--terminal-host`) with its own lock in `<state-dir>/terminal-runtime/`, socket and credential. Replacing the worker never touches shells. The web starts the host when a shell is opened; the host exits after 30 seconds with no shell and no web request. Shells opened in a worker from before the terminal host remain reachable through that worker until closed.

The worker, terminal host and master host keep their `/tmp` socket and credential alive while they run (`server/runs/endpoint-keeper.ts`): every 5 seconds a credential that a `/tmp` cleaner removed is written again with the same value, and files older than an hour are touched. Without it, a host that lost its credential still holds its lock, so no replacement can start and its clients are locked out.

The first upgrade from an older in-process runner needs a handoff or a fully drained old server: its old SIGTERM handler still cancels work. Do not start a new worker against the same state files while the old runner is writing them. Test with fixtures; never kill the old process merely to test restart behavior.

### Encrypted secrets

Owner secret management requires direct localhost or an explicitly configured authenticated HTTPS origin. Caller-supplied forwarded-protocol headers do not establish HTTPS.

The conversation's secret icon opens a paste field for a value or dotenv content; **Confirm** connects it to the current task. Optional **Save for later** selects the global or current-project vault, and the saved list supports search and one-click owner connection in other sessions. Initial setup and unlocking ask for the vault password inline; temporary values remain encrypted too. **Settings → Secrets** separates saved values, project connections, remote sharing and security. Project connections can make selected keys always available; advanced field/operation/expiry controls remain available. Global storage does not imply `allProjects` authorization. Explicit owner connection may create an exact host/project manual rule for a saved global key, but never replaces disabled or expired policies, broadens an existing rule, or extends its grant deadline. Task lifetime is independent of model summaries and turn completion. Explicit task closure, session archive and expiry revoke later use and clear temporary payload; a previously authenticated run cannot rebind to a replacement task. Lock, revoke and web disconnect do not kill agents or terminals, and cannot recover plaintext already given to a consumer.

`server/secrets/` owns encryption, task/policy authorization, the consumer broker, remote proof and runtime tools. `shared/secrets.ts` contains public metadata/reference contracts. `SecretVault` uses a random 256-bit Vault key, a password wrapper derived with Argon2id (64 MiB, three passes, four lanes), and AES-256-GCM with fresh nonces and purpose/version/Vault-bound AAD. `secrets/vault.json` stores permanent encrypted records; `secrets/journal.json` separately encrypts temporary values, tasks, grants and operation claims. Reads refuse symlinks and are bounded; writes use private permissions, exclusive temporary files, fsync and atomic rename. Journal-first commits preserve denial/pending state; persistence failure locks the service. A new execution worker starts locked, while a web reconnect retains the existing worker's unlock. Passwords belong only to owner control requests, not prompts, argv, provider environments or the generic operation ledger.

Use the run-scoped MCP tools (`secrets_list`, `secrets_run`, `secrets_compare`, `secrets_fingerprint`, `secrets_cli`). Lists return metadata, not values; while the vault is locked they come from `secrets/index.json`, a plaintext policy index (names, references, rules, tasks, grants; no values or keys) rewritten at every unlocked save and evaluated by the same `policy.ts` authorization, and any use fails with an unlock request. The broker launches consumers without a shell and supplies only requested secrets through env, stdin or private files outside the project. Selected dotenv fields support env-bundle delivery; whole-file delivery requires all fields. It reauthorizes before spawn and masks bounded stdout/stderr before tool or CLI output. Internal equality and domain-scoped HMAC fingerprints require operation permission and use the same final authorization gate before computing their result. No raw-value read/export command exists. The operation journal gives a duplicate request its recorded result or an uncertain response rather than running it again.

Secret tools remain available for discovery when the current task actually needs credentials; ordinary turns receive no secret guide in their prompt. Tool descriptions explain reference discovery and consumer mapping, and tell agents to leave unrelated work and vault state alone. Only an explicit connection from the chat key input opts into a fixed, value-free notice for that session's active native turn. Vault setup/unlock/lock, saved-value edits, project automatic connections, revocation, expiry and source availability changes remain silent; the broker still checks current authority at each use. A remote chat connection carries its committed target over the separately approved paired link before reading the owner's overview; the receiving worker checks owner eligibility, exclusions and the current task ID. Notices coalesce and wait during approvals or another insert; an uncertain delivery is not resent. Idle sessions do not start a turn for a notice. The private block is hidden from Tower chat and never stored as a new run or user prompt; it can remain in the provider's native history. It contains no secret names, references, values or owner input and grants no additional permission. Desktop-owned conversations do not receive these inserts.

The CLI shares the MCP parser. Direct invocation requires the current run's authenticated `TOWER_SECRET_CAPABILITY` and absolute `TOWER_SECRET_STATE_DIR`; cwd, a native thread ID or a worker master credential never supplies a secret subject. These examples use references from `list`, not literal values:

```sh
agent-session-tower secrets list --json
agent-session-tower secrets run --env API_TOKEN='tower-secret://VAULT/SECRET@1#TOKEN' --operation-id request-1 -- node script.mjs
agent-session-tower secrets pipe --secret 'tower-secret://VAULT/SECRET@1' --operation-id request-2 -- node stdin-consumer.mjs
agent-session-tower secrets fingerprint 'tower-secret://VAULT/SECRET@1' --domain deployment
```

`run`/`pipe` need a stable `--operation-id`; retry with the same ID and do not automatically assign a new one after an uncertain result. The capability belongs to the secret MCP transport, not the provider's global environment. The consumer environment strips Tower credentials. Same-UID code and trusted consumers can read delivered plaintext; exact/escaped/encoded output masking does not prevent deliberate transformations, arbitrary file access or network disclosure. This is not an OS sandbox or a complete data-loss prevention system.

Remote use requires an existing pinned Tower link **and** owner approval of each Vault's independent Ed25519/X25519 public-key fingerprint. On source A, one logical project binds A and B by host ID plus exact canonical root; B's local project UUID may differ. A authorizes B's keys, fields and operations, and both A and B must be unlocked. A's policy is checked for each signed request; signed, sealed responses bind the request and recipient. The relay holds opaque envelopes and B stores no permanent secret replica. Remote tasks expire after eight hours, grants have fixed deadlines, and locked/offline sources fail closed. Manual connection happens on A's page by selecting B's verified session; B cannot edit/delete A's values. An unavailable remote close is reported, with source cleanup bounded by expiry; it never cancels the provider turn.

Vault initialization migrates the known legacy trigger-secret file through the encrypted store, preserving ID/origin/createdAt and the engine's trigger grants. Commit and verification precede plaintext unlink; after initialization there is no plaintext fallback or dual write. Backups include only the encrypted permanent Vault, never the runtime journal or temporary task payload. A legacy-only backup restored before Vault initialization keeps the existing worker restoration path. When either the source or target has a Vault, restore stages encrypted imports instead of replacing the target Vault: owner target unlock plus the **source Vault password** imports permanent records without copying source identity/trust or activating source sharing bindings/rules. A deferred trigger snapshot and legacy trigger records are encrypted with the **backup passphrase**, so they may be a separate pending item requiring a different password. The trigger snapshot stays pending until referenced secrets can be validated; current trigger definitions are preserved until that point. A pending import is not reported as applied.

Fixtures live in `tests/server/secrets/` and `tests/server/backup/secrets.test.ts`. They cover ciphertext/KDF failures, restart lock, literal dotenv parsing, atomic failure recovery, selected fields, task/run isolation, TTL/revocation/sweep, authenticated transport, output masking, two encrypted runtimes and deferred trigger grants. Use fixture run registries and ordinary synthetic consumers; do not spawn native providers or scan personal session homes to verify secrets.

### Conversation image previews

Conversation pages include signed image URLs for local Markdown image/file links and saved Codex generated-image paths in tool results. The web process serves PNG, JPEG, GIF, and WebP up to 20 MiB after checking authentication, the current session, canonical project/generated-image roots, and file signatures. Joined-computer requests additionally recheck session visibility and excluded folders. No external URL is fetched by the server. Image URLs are renewed when a conversation is fetched after web restart; native history is unchanged.
