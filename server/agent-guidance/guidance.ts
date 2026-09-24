/**
 * Instructions every Claude Code and Codex session on this computer receives, whichever project
 * it works in. Tower rewrites them when it starts, so a new installation carries them along.
 */
export const AGENT_GUIDANCE = `# Agent Session Tower

Agent Session Tower maintains this text and replaces it when it starts. Project instructions take precedence over it.

## Keep git branches in sync

Several agents can work in the same repository folder at once, and branches are often merged on the remote. Local branches then fall behind, or keep commits nobody pushed.

Before you change files in a git repository:
- Run \`git fetch\` and compare the current branch with its upstream (\`git status -sb\`).
- If the branch is only behind and no tracked file has uncommitted changes, fast-forward it with \`git pull --ff-only\`.
- If it has diverged, or there are changes you did not make, do not merge, rebase, stash, reset or discard anything to get around it. Say so, and if the changes are in your way, work in a separate worktree.
- Start new branches from the up-to-date upstream (for example \`origin/main\`), not from a stale local branch.

Use a separate worktree when another agent is working in the same folder, or for long work:
- \`git worktree add ../<repo>-<task> -b <branch> origin/<base>\`
- Once the work is merged or pushed, remove it with \`git worktree remove\` and delete the merged branch.
- A small change in a folder nobody else is using can be made in place.

When you finish:
- Commit only your own changes.
- Do not leave commits unpublished without saying so. Push to the branch's upstream when the project's workflow or the user expects it, never force-pushing; otherwise report which commits remain local and why.
`;
