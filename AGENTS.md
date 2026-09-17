# Verification

- Keep test conversations out of the user's native session history. A temporary working directory alone does not isolate Codex or Claude Code sessions.
- Before running a live native check, use a dedicated provider configuration home outside every home scanned by the regular Tower instance. Fail before spawning the provider if isolation is not configured or session storage points into a personal home. Do not copy personal credentials into test homes.
- Prefer fixture-based checks. For live checks, verify that child agents use isolated storage too; do not assume an ephemeral parent guarantees this.
- If an earlier check leaked a session, hide only the proven test session IDs using Tower's existing close-session API. Preserve native records and unrelated sessions. Do not add broad filters for temporary paths.
- See [docs/development.md](docs/development.md) for the live-check workflow.
