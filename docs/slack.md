# Slack automation

Tower watches mentions of your Slack user and opens a dedicated conversation for each new mention. Its agent reads the thread and configured instructions, delegates work through Auto Prompt, and proposes replies for your review in Tower chat. Slack messages are sent only after you explicitly approve a specific proposal in that chat, by message or approval button. You can continue the conversation directly in Tower.

This initial integration uses a private Slack app with Socket Mode and a **user OAuth token**. Replies are posted as that user. There is no hosted OAuth callback or one-click installation flow. Tokens stay in an owner-readable file in Tower's state directory and are never returned to the browser or passed to the agent.

## Connect

1. Create an internal Slack app for your workspace at <https://api.slack.com/apps>. Workspace policy may require an administrator to approve it.
2. Enable **Socket Mode**. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write` (starts with `xapp-`).
3. Under **OAuth & Permissions → User Token Scopes**, add `channels:history`, `groups:history`, `im:history`, `mpim:history`, and `chat:write`. Omit conversation types you do not want to monitor, together with their event subscriptions below.
4. Under **Event Subscriptions → Subscribe to events on behalf of users**, add `message.channels`, `message.groups`, `message.im`, and `message.mpim` for the enabled scopes. Use user events, not `app_mention`: the target is your personal account.
5. Install/reinstall the app to your workspace and obtain its **User OAuth Token** (`xoxp-`). Use the same app/workspace for both tokens. Token rotation is not implemented; use an internal app without token rotation for this version.
6. Open **Slack automation** in the Tower header and enter the two tokens. Save instructions, then explicitly enable monitoring. Connecting alone does not enable it.

Socket Mode needs outbound HTTPS and WebSocket access to Slack; it does not require a public callback URL. Slack delivers only messages accessible to the app's authorized user and scopes. This version processes newly delivered direct user mentions (`<@USER_ID>`), not historic mentions, edits that introduce a mention, group mentions, or bot-generated messages. Events missed during a prolonged outage are not backfilled.

Your own messages are excluded by default. To test a saved rule, enable **Process my own mentions (for testing)** in Slack automation settings, then send a new message mentioning yourself. This works in accessible private channels too when `groups:history` and `message.groups` are configured. The setting is saved across restarts. Test mentions perform the real configured task and generate reply proposals, so disable this option after testing if you only want other people’s requests. Earlier ignored messages are not replayed. Tower escapes mentions in its own generated replies to prevent reply loops; bot messages and message edits remain excluded.

## Conversation language

Slack coordinator responses follow Tower’s Korean/English language setting. Opening a connected Tower page or changing its language synchronizes the preference to the execution worker, where it persists for background mentions while the browser is closed. Existing conversations use the current preference on their next turn or delegated result. Quoted Slack messages, user-approved reply text, code, and identifiers stay unchanged.

## Canvas monitor

Connecting an account adds a **Slack monitor** to the canvas. Drag its header to move it; its position is remembered in both automatic and manual layouts. New mentions appear as cards inside it, and active work uses the same animated rainbow border as agent sessions. Connection problems remain visible alongside running work.

The monitor shows the latest five mentions as short cards in descending order. **Show more** loads five older conversations at a time. Click a card to open the ordinary session chat, including its composer and active-run controls. Follow-up instructions remain in the same dedicated conversation. These one-off coordinator sessions stay out of the ordinary session list and project canvas; their histories remain available through Slack monitor. Records created before this conversation feature retain their previous detail view and are not replayed.

## Instructions

Each item has a name, matching condition, execution instructions, reply instructions, provider, optional model, optional known working folder, and enabled flag. The dedicated agent receives a snapshot of enabled rules and the original thread, chooses the first applicable rule, and explains its decision in chat. No clear match means it should explain and wait for your direction rather than execute or reply. The first enabled rule selects the coordinator's provider and model, defaulting to Codex when no rule is enabled. Choose a model beside the agent using the same available-model list as ordinary chat, or keep the agent default. Changing the agent clears the previous model selection. Delegated work follows the matched rule's provider, model, and folder. Auto Prompt's routing model stays fixed; this setting controls task execution. Saved changes apply to new mentions; existing conversations retain their rule snapshots.

The **Verse8 PR review** example is disabled until you enable and save it. Customize it with your actual repository scope and review process. For example:

- Condition: A person explicitly requests my review of a pull request for the Verse8 repositories listed here: …
- Execution: Read the PR and relevant code, review correctness and regressions, and post findings to the PR if any. Do not merge the PR. Report what you checked and whether review comments were posted.
- Reply proposal guidance: After a completed review, suggest `확인 했습니다.` when there are no findings, or `코멘트 확인 부탁드립니다.` when review comments were posted. Use this only to draft numbered reply choices; never send automatically. Do not claim completion when blocked.

If a folder is omitted, Auto Prompt chooses from known Tower folders. Codex automation always requests Auto approval review (`auto_review`); its review agent evaluates approval requests within the existing sandbox rules. To apply this setting reliably, Codex automation starts a new session in the selected folder even if the router finds an existing session. If Codex does not confirm Auto review, Tower stops before submitting the task. Native provider authentication still applies. Waiting for approval is not successful completion. The coordinator receives workflow-bound tools: `tower_auto_prompt`, `tower_task_status`, `tower_task_complete`, `slack_thread`, and `slack_reply`. The `slack_reply` tool only saves a reply proposal; it cannot send a Slack message. Reply instructions guide drafting and never authorize transmission. The agent presents numbered choices (1, 2, 3) in Tower chat. Discuss revisions in that same conversation, then explicitly request **Send reply 3 to Slack** in chat, or select a proposal and say **I approve**. You can also click the exact proposal text to approve and send it. Merely selecting a number or pasting a draft does not send it. Each approval is bound to that stored text and original thread. Only authenticated owner messages or the approval button can approve a send. Model tool calls, automatic result notifications, Auto approval review, and rule text cannot grant approval. Ambiguous messages need a clearer choice before anything is sent. Credentials are not included in model prompts or tool results. Auto approval review is also checked when resuming the coordinator.

You can authorize a completion reply in advance: **작업이 완료되면 그냥 배포됐습니다 라고 코멘트 다세요.** Tower saves the exact wording and binds it to the single pending delegated task. When that task finishes, the coordinator verifies its result and reports the outcome and evidence with `tower_task_complete`. Only a successful assessment of the matching completed run can send the already authorized wording; you do not have to approve it again. Failed, cancelled, or uncertain work does not send a success reply. The tool cannot grant approval or change the approved text. If multiple tasks are pending, clarify the target first. A reply rule alone is never advance approval.

Delegation passes the requested outcome, relevant project context, and explicit owner constraints. The project agent reads its own instructions and plans implementation and verification locally. The coordinator does not add Slack reply policy, its own command sequences, or invented restrictions to the delegated prompt. Explicit scope such as a read-only investigation remains binding. Slack reply approval stays in the coordinator conversation.

## Execution and recovery

The independent execution worker owns monitoring. Closing the browser or stopping/restarting the web server does not stop it. Disable monitoring explicitly to stop accepting new mentions; already accepted work continues. To cancel an executing task, use Tower's ordinary run controls. Disconnect/account replacement is available once accepted workflows finish.

After delegation, the coordinator ends its turn to free the execution slot. Tower tracks the actual delegated run and automatically resumes the coordinator with its result when it finishes. The agent then assesses the result and prepares numbered reply proposals for your approval. Without prior owner approval, completion only produces reply proposals. When a delegated task finishes, sessions proven to have been newly created for it and their finished subagents are automatically removed from the canvas. Their history remains accessible in the sidebar; native conversations and processes are not deleted or stopped. Reused user sessions and sessions with active work remain visible. This cleanup also excludes completed temporary work from future automatic routing. The monitor remains active while delegated work is outstanding. `Auto Prompt completed` alone only means execution was admitted, not that the work succeeded.

Older processing records also stop at a reply proposal and require explicit approval; upgrading never approves or sends pending replies.

Events, rule snapshots, coordinator identities, delegated tasks, result notifications, reply proposals, and approval/send records are persisted to prevent duplicate work across event redelivery and restart. Slack reply transmission is not automatically retried after an uncertain network result; check the original thread manually when activity says **reply uncertain**. Read/model/routing failures are recorded without automatically rerunning the work.

Threads that cannot be fetched completely or fit the bounded execution context stop with an error; Tower never silently executes from a partial thread. Slack may rate limit reads; the client respects short `Retry-After` delays and reports longer limits. Processing history is local and contains Slack thread text: protect Tower's state directory accordingly.

Official references: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [message events](https://docs.slack.dev/reference/events/message/), [thread retrieval](https://docs.slack.dev/reference/methods/conversations.replies/).
