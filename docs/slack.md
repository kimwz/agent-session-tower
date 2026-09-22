# Slack automation

Tower can watch mentions of your Slack user, read the surrounding thread, match an ordered list of instructions, run a matching task through Auto Prompt, and reply in that thread after execution finishes.

This initial integration uses a private Slack app with Socket Mode and a **user OAuth token**. Replies are posted as that user. There is no hosted OAuth callback or one-click installation flow. Tokens stay in an owner-readable file in Tower's state directory and are never returned to the browser or passed to the agent.

## Connect

1. Create an internal Slack app for your workspace at <https://api.slack.com/apps>. Workspace policy may require an administrator to approve it.
2. Enable **Socket Mode**. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write` (starts with `xapp-`).
3. Under **OAuth & Permissions → User Token Scopes**, add `channels:history`, `groups:history`, `im:history`, `mpim:history`, and `chat:write`. Omit conversation types you do not want to monitor, together with their event subscriptions below.
4. Under **Event Subscriptions → Subscribe to events on behalf of users**, add `message.channels`, `message.groups`, `message.im`, and `message.mpim` for the enabled scopes. Use user events, not `app_mention`: the target is your personal account.
5. Install/reinstall the app to your workspace and obtain its **User OAuth Token** (`xoxp-`). Use the same app/workspace for both tokens. Token rotation is not implemented; use an internal app without token rotation for this version.
6. Open **Slack automation** in the Tower header and enter the two tokens. Save instructions, then explicitly enable monitoring. Connecting alone does not enable it.

Socket Mode needs outbound HTTPS and WebSocket access to Slack; it does not require a public callback URL. Slack delivers only messages accessible to the app's authorized user and scopes. This version processes newly delivered direct user mentions (`<@USER_ID>`), not historic mentions, edits that introduce a mention, group mentions, or bot-generated messages. Events missed during a prolonged outage are not backfilled.

## Instructions

Each item has a name, matching condition, execution instructions, reply instructions, provider, optional known working folder, and enabled flag. The tool-free classifier selects the first applicable rule in display order. A mention runs at most one rule. No clear match means no execution or reply. The first enabled rule's provider performs classification; the matched rule's provider performs routing, execution, and reply composition.

The **Verse8 PR review** example is disabled until you enable and save it. Customize it with your actual repository scope and review process. For example:

- Condition: A person explicitly requests my review of a pull request for the Verse8 repositories listed here: …
- Execution: Read the PR and relevant code, review correctness and regressions, and post findings to the PR if any. Do not merge the PR. Report what you checked and whether review comments were posted.
- Reply: After a completed review, reply `확인 했습니다.` when there are no findings, or `코멘트 확인 부탁드립니다.` when review comments were posted. Do not claim completion when blocked.

If a folder is omitted, Auto Prompt chooses from known Tower folders. Codex automation always requests Auto approval review (`auto_review`); its review agent evaluates approval requests within the existing sandbox rules. To apply this setting reliably, Codex automation starts a new session in the selected folder even if the router finds an existing session. If Codex does not confirm Auto review, Tower stops before submitting the task. Native provider authentication still applies. Waiting for approval is not successful completion. The agent receives the saved instruction plus Slack context; Tower handles the final Slack reply itself.

## Execution and recovery

The independent execution worker owns monitoring. Closing the browser or stopping/restarting the web server does not stop it. Disable monitoring explicitly to stop accepting new mentions; already accepted work continues. To cancel an executing task, use Tower's ordinary run controls. Disconnect/account replacement is available once accepted workflows finish.

Activity shows matching, routing, execution, reply, ignored, and error states. `Auto Prompt completed` only means execution was admitted; Slack waits for the actual run to complete and generates a reply grounded in its output. A failed/cancelled run or unverifiable result produces no success reply.

Events, the matching rule snapshot, the execution prompt, and run IDs are persisted to prevent duplicate work across event redelivery and restart. Slack reply transmission is not automatically retried after an uncertain network result; check the original thread manually when activity says **reply uncertain**. Read/model/routing failures are recorded without automatically rerunning the work.

Threads that cannot be fetched completely or fit the bounded execution context stop with an error; Tower never silently executes from a partial thread. Slack may rate limit reads; the client respects short `Retry-After` delays and reports longer limits. Processing history is local and contains Slack thread text: protect Tower's state directory accordingly.

Official references: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [message events](https://docs.slack.dev/reference/events/message/), [thread retrieval](https://docs.slack.dev/reference/methods/conversations.replies/).
