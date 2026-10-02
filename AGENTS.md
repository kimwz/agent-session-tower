# Verification

- Keep test conversations out of the user's native session history. A temporary working directory alone does not isolate Codex or Claude Code sessions.
- Reviews, helper agents and live native checks use the existing Claude/Codex CLI login on this computer by default. Do not require a separately authenticated profile, a new login or Vault access, and do not inspect or copy authentication values. Separate temporary cwd, fixture data and Tower state from authentication. Use supported nonpersistent execution options when possible.
- Prefer fixture-based checks. Use read-only reviews and disable unnecessary tools, MCP servers and child agents. Verify child record handling independently; do not assume an ephemeral parent makes children nonpersistent. A native check that must persist tracks its exact test session IDs for the close-session procedure below.
- If an earlier check leaked a session, hide only the proven test session IDs using Tower's existing close-session API. Preserve native records and unrelated sessions. Do not add broad filters for temporary paths.
- See [docs/development.md](docs/development.md) for the live-check workflow.
- When UI verification is part of authorized delivery, an already permitted isolated Playwright test browser with fixture data does not need a second approval merely because no personal browser is connected. Honor an explicitly selected browser and actual access denials; do not bypass them.

# Execution lifetime

- Tower is a monitoring and task-submission interface. Stopping or restarting its web server must not cancel agent turns, kill Claude/Codex processes, or close active terminal shells.
- Provider transports, approvals, and Auto Prompt routing belong to the independent execution worker; terminal shells belong to the separate terminal host. Web shutdown only disconnects its client; a new web process reattaches to the same worker, and a worker from an older build hands off to the new one only when nothing is running.
- Send cancellation or termination only for an explicit user stop/close action. Never infer cancellation from lost UI connections.
- Verify lifecycle changes with isolated fake-provider processes, including web-process termination and reconnect. Prefer nonpersistent native checks; track and close only proven test session IDs if a persistent check is necessary.

# Release and deployment

- Changes reach `main` only through a reviewed and merged pull request. Tower's release and deployment then follow without a separate request.
- A pull request that changes what Tower does carries its own release: the dated `CHANGELOG.md` section and the version bump. After merging, tag the commit the merge put on `main`. Follow "Releasing" in `docs/development.md`, including its checks before merging and before tagging. Never force-push a branch or move a tag.
- A pull request that changes only documentation, agent instructions, tests, or CI has no version, changelog entry, or release; its changes ship with the next release.
- Review the release contents before committing. Preserve unrelated work and exclude credentials, personal state, test-session data, and generated build output.
- Build and deploy the new version, preserving active agent turns and terminal shells. Verify the running version and that the release tag points at the merged commit on `main` before reporting completion.
- A Tower running as the background service (`agent-session-tower service install`) is deployed by asking it to update, never by restarting its web by hand or starting a checkout in its place: after the Release workflow publishes the package, `POST /api/tower/update` with `{ "version": "x.y.z" }` on its local port (page token from `/api/bootstrap`), then confirm `/api/health` reports that version with `service: true`. It otherwise moves to the latest release by itself within about 30 minutes, and joined computers follow it.
- Report the deployed version, the merged pull request, and the release link. If any step fails or remains local-only, state exactly what is incomplete; do not describe it as a completed deployment.
