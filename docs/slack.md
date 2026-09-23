# Slack automation

Tower watches mentions of your Slack user and opens a dedicated conversation for each new mention. Its agent reads the thread and configured instructions, delegates work through Auto Prompt, and proposes replies for your review in Tower chat. A new Slack event never authorizes a reply by itself. You can authorize sending in Tower chat, including asking the agent to write and send a reply or report the result when work finishes; clicking a proposal is optional. You can continue the conversation directly in Tower.

This initial integration uses a private Slack app with Socket Mode and a **user OAuth token**. Replies are posted as that user. There is no hosted OAuth callback or one-click installation flow. Tokens stay in an owner-readable file in Tower's state directory and are never returned to the browser or passed to the agent.

## Connect

1. Create an internal Slack app for your workspace at <https://api.slack.com/apps>. Workspace policy may require an administrator to approve it.
2. Enable **Socket Mode**. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write` (starts with `xapp-`).
3. Under **OAuth & Permissions → User Token Scopes**, add `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`, and `reactions:write` (progress emoji for auto-reply rules). Omit conversation types you do not want to monitor, together with their event subscriptions below.
4. Under **Event Subscriptions → Subscribe to events on behalf of users**, add `message.channels`, `message.groups`, `message.im`, and `message.mpim` for the enabled scopes. Use user events, not `app_mention`: the target is your personal account.
5. Install/reinstall the app to your workspace and obtain its **User OAuth Token** (`xoxp-`). Use the same app/workspace for both tokens. Token rotation is not implemented; use an internal app without token rotation for this version.
6. Open **Slack automation** in the Tower header and enter the two tokens. Save instructions, then explicitly enable monitoring. Connecting alone does not enable it.

Socket Mode needs outbound HTTPS and WebSocket access to Slack; it does not require a public callback URL. Slack delivers only messages accessible to the app's authorized user and scopes. This version processes newly delivered direct user mentions (`<@USER_ID>`), not historic mentions, edits that introduce a mention, group mentions, or bot-generated messages. Events missed during a prolonged outage are not backfilled.

Your own messages are excluded by default. To test a saved rule, enable **Process my own mentions (for testing)** in Slack automation settings, then send a new message mentioning yourself. This works in accessible private channels too when `groups:history` and `message.groups` are configured. The setting is saved across restarts. Test mentions perform the real configured task and generate reply proposals, so disable this option after testing if you only want other people’s requests. Earlier ignored messages are not replayed. Replies keep explicit `<@USER_ID>` mentions only for people who wrote in that thread, including you; other mentions and broadcasts such as `<!channel>` are escaped. Tower ignores its own posted replies, so a reply that mentions you never starts a new conversation. Bot messages and message edits remain excluded.

## Conversation language

Slack coordinator responses follow Tower’s Korean/English language setting. Opening a connected Tower page or changing its language synchronizes the preference to the execution worker, where it persists for background mentions while the browser is closed. Existing conversations use the current preference on their next turn or delegated result. Quoted Slack messages, user-approved reply text, code, and identifiers stay unchanged.

## Canvas monitor

Connecting an account adds a **Slack monitor** to the canvas. Drag its header to move it; its position is remembered in both automatic and manual layouts. New mentions appear as cards inside it, and active work uses the same animated rainbow border as agent sessions. Connection problems remain visible alongside running work.

Completed threads you have not opened have an unread border. Opening the thread marks its current result as read in that browser; a later completed result becomes unread again. Threads with a confirmed sent reply use a success border. Active work keeps its animated border.

The monitor shows the latest five mentions as short cards in descending order. **Show more** loads five older conversations at a time. Click a card to open the ordinary session chat, including its composer and active-run controls. Follow-up instructions remain in the same dedicated conversation. These one-off coordinator sessions stay out of the ordinary session list and project canvas; their histories remain available through Slack monitor. Records created before this conversation feature retain their previous detail view and are not replayed.

## Writing style collection

Open the Slack monitor header, then expand **Writing style / 말투 수집**. **Collect my messages** reads up to 200 of the connected account’s messages from the last 90 days and asks the configured agent provider to summarize their writing style. This optional feature needs `search:read` in the Slack app’s **User Token Scopes**; add it, reinstall the app, and reconnect the user token if collection reports missing scope.

Collection only reads Slack. Messages from other users, bots, and known Tower-sent replies are excluded. Samples are processed by the model but are not saved as a Tower message archive; only the resulting guide and collection metadata are stored locally. Review or edit the guide and enable **Use for reply proposals** before using it. You can reset it at any time. The guide is specific to the connected account, influences drafting style only, and never changes project instructions, send authorization, or exact text already approved by the owner.

## Instructions

Each item has a name, matching condition, execution instructions, reply instructions, provider, optional model, optional known working folder, and enabled flag. The dedicated agent receives a snapshot of enabled rules and the original thread, chooses the first applicable rule, and explains its decision in chat. No clear match means it should explain and wait for your direction rather than execute or reply. The first enabled rule selects the coordinator's provider and model, defaulting to Codex when no rule is enabled. Choose a model beside the agent using the same available-model list as ordinary chat, or keep the agent default. Changing the agent clears the previous model selection. Delegated work follows the matched rule's provider, model, and folder. Auto Prompt's routing model stays fixed; this setting controls task execution. Saved changes apply to new mentions; existing conversations retain their rule snapshots.

The **Verse8 PR review** example is disabled until you enable and save it. Customize it with your actual repository scope and review process. For example:

- Condition: A person explicitly requests my review of a pull request for the Verse8 repositories listed here: …
- Execution: Read the PR and relevant code, review correctness and regressions, and post findings to the PR if any. Do not merge the PR. Report what you checked and whether review comments were posted.
- Reply proposal guidance: After a completed review, suggest `확인 했습니다.` when there are no findings, or `코멘트 확인 부탁드립니다.` when review comments were posted. Use this only to draft numbered reply choices; never send automatically. Do not claim completion when blocked.

If a folder is omitted, Auto Prompt chooses from known Tower folders using the matched rule’s project instructions as routing context. An explicit rule folder takes precedence. Every Slack-delegated task starts a new session; it never queues work onto an existing project conversation. Codex automation always requests Auto approval review (`auto_review`); its review agent evaluates approval requests within the existing sandbox rules. This applies to the fresh Codex session in the selected folder. If Codex does not confirm Auto review, Tower stops before submitting the task. Native provider authentication still applies. Waiting for approval is not successful completion. The coordinator receives workflow-bound tools: `tower_auto_prompt`, `tower_task_status`, `tower_task_complete`, `slack_thread`, `slack_reply`, and `slack_send`. `slack_reply` saves numbered proposals. `slack_send` can send an agent-written reply only when a prior authenticated owner message authorized it. Slack messages, automatic result notifications, Auto approval review, and ordinary rule text never grant sending permission. `slack_react` adds or removes an emoji on the original request message while reply permission exists. Credentials are not included in model prompts or tool results.

You can say **Send reply 3 to Slack**, select a proposal and say **I approve**, or ask **수정한 내용으로 슬랙에 답변 보내주세요**. Clicking the proposal text is another option, not a requirement. Merely selecting a number, discussing a draft, or asking about progress does not authorize sending. Exact wording approvals preserve that text; when you authorize the agent to compose the reply, it may draft the message using the conversation, verified result, and enabled tone guide without another approval step.

You can also interrupt ongoing work with **작업 끝나면 그냥 슬랙에 알려주세요**. Tower persists that permission at message receipt and binds it to the pending delegated work, including routing work. The coordinator verifies the actual outcome before using `tower_task_complete` to send the authorized report. A request made before delegation can bind to the next task. An exact success message such as **작업이 완료되면 배포됐습니다 라고 코멘트 다세요** still requires success; a general result report must accurately describe failures or uncertainty. **슬랙에 보내지 마세요** cancels pending permission. Sending permission is consumed once, survives restart, and never authorizes duplicate retries after an uncertain send.

Delegation passes the requested outcome, relevant project context, and explicit owner constraints. The project agent reads its own instructions and plans implementation and verification locally. The coordinator does not add Slack reply policy, its own command sequences, or invented restrictions to the delegated prompt. Explicit scope such as a read-only investigation remains binding. Slack reply approval stays in the coordinator conversation.

### Auto-reply rules

Enable **Auto-reply with the result without approval / 승인 없이 결과 자동 답변** on a rule to authorize its outcome report in advance. When the coordinator delegates work with that rule, Tower records the same one-time, task-bound permission as **작업 끝나면 그냥 슬랙에 알려주세요**, drafted from the rule's reply guidance. The coordinator verifies the actual outcome and sends one reply, reporting failures truthfully. It can also mark progress on the request message, for example ⏳ while working and ✅ after replying, when the rule asks for it. A Slack message can select the rule but cannot turn the option on. Owner chat still takes precedence: **슬랙에 보내지 마세요** cancels the pending report and further reactions. Reactions need the `reactions:write` user scope; reconnect the token after adding it.

Example execution instruction: *Before redeploying, add an hourglass reaction to the request. After the deployment, reply with the result mentioning the requester, then replace the hourglass with a check mark.*

To test with your own account, enable **Process my own mentions (for testing)** and mention yourself in a test channel. The rule runs the real task, so point it at harmless work while testing.

## Execution and recovery

The independent execution worker owns monitoring. Closing the browser or stopping/restarting the web server does not stop it. Disable monitoring explicitly to stop accepting new mentions; already accepted work continues. To cancel an executing task, use Tower's ordinary run controls. Disconnect/account replacement is available once accepted workflows finish.

After delegation, the coordinator ends its turn to free the execution slot. Tower tracks the actual delegated run and automatically resumes the coordinator with its result when it finishes. The agent then assesses the result and either sends a previously authorized report or prepares numbered reply proposals for your review. Without prior owner approval, completion only produces reply proposals. When a delegated task finishes, sessions proven to have been newly created for it and their finished subagents are automatically removed from the canvas. Their history remains accessible in the sidebar; native conversations and processes are not deleted or stopped. Reused user sessions and sessions with active work remain visible. This cleanup also excludes completed temporary work from future automatic routing. When a Claude agent launches a fresh Codex CLI review, Tower can recover the parent relationship from the actual command, matching the full initial prompt, working directory, and bounded execution time; a foreground completion result tightens that time window when available. Background launch acknowledgements do not count as completion. Supported literal launches include output-file redirection with an exit-status marker, and existing records are re-evaluated on refresh or restart. Uniquely matched reviews appear in the parent conversation family rather than as standalone worktree projects; completed descendants follow the same cleanup. A worktree name, missing folder, or CLI origin alone never proves delegation. Unmatched or ambiguous sessions remain independent. The monitor remains active while delegated work is outstanding. `Auto Prompt completed` alone only means execution was admitted, not that the work succeeded.

Older processing records also stop at a reply proposal and require explicit approval; upgrading never approves or sends pending replies.

Events, rule snapshots, coordinator identities, delegated tasks, result notifications, reply proposals, and approval/send records are persisted to prevent duplicate work across event redelivery and restart. Slack reply transmission is not automatically retried after an uncertain network result; check the original thread manually when activity says **reply uncertain**. Read/model/routing failures are recorded without automatically rerunning the work.

Threads that cannot be fetched completely or fit the bounded execution context stop with an error; Tower never silently executes from a partial thread. Slack may rate limit reads; the client respects short `Retry-After` delays and reports longer limits. Processing history is local and contains Slack thread text: protect Tower's state directory accordingly.

Official references: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [message events](https://docs.slack.dev/reference/events/message/), [thread retrieval](https://docs.slack.dev/reference/methods/conversations.replies/).
