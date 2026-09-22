# Verification

- Keep test conversations out of the user's native session history. A temporary working directory alone does not isolate Codex or Claude Code sessions.
- Before running a live native check, use a dedicated provider configuration home outside every home scanned by the regular Tower instance. Fail before spawning the provider if isolation is not configured or session storage points into a personal home. Do not copy personal credentials into test homes.
- Prefer fixture-based checks. For live checks, verify that child agents use isolated storage too; do not assume an ephemeral parent guarantees this.
- If an earlier check leaked a session, hide only the proven test session IDs using Tower's existing close-session API. Preserve native records and unrelated sessions. Do not add broad filters for temporary paths.
- See [docs/development.md](docs/development.md) for the live-check workflow.

# Execution lifetime

- Tower is a monitoring and task-submission interface. Stopping or restarting its web server must not cancel agent turns, kill Claude/Codex processes, or close active terminal shells.
- Provider transports, approvals, Auto Prompt routing, and terminal shells belong to the independent execution worker. Web shutdown only disconnects its client; a new web process reattaches to the same worker.
- Send cancellation or termination only for an explicit user stop/close action. Never infer cancellation from lost UI connections.
- Verify lifecycle changes with isolated fake-provider processes, including web-process termination and reconnect. Do not create native test conversations in personal homes.

# Deployment and release completion

- A requested deployment includes the version bump, changelog, commit, release tag, and push to the configured remote branch. Local server changes alone do not complete a deployment. Do not require a second request to publish the already authorized release.
- Follow `docs/development.md`: choose the appropriate semantic version, write release notes dated today, run the required checks, use the release scripts to synchronize package and application versions, and push the commit and annotated version tag without force-pushing.
- Review the release contents before committing. Preserve unrelated work and exclude credentials, personal state, test-session data, and generated build output.
- Build and deploy the new version, preserving active agent turns and terminal shells. Verify the running version and the remote branch/tag commit IDs before reporting completion.
- Report the deployed version and pushed commit or release link. If any step fails or remains local-only, state exactly what is incomplete; do not describe it as a completed deployment.
