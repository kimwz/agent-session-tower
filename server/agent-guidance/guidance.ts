/**
 * Instructions every Claude Code and Codex session on this computer receives, whichever project
 * it works in. Tower rewrites them when it starts, so a new installation carries them along.
 */
export const AGENT_GUIDANCE = `# Agent Session Tower

Agent Session Tower maintains this text and replaces it when it starts. Project instructions take precedence over it.

## Build on earlier sessions

Tower's session tools (\`sessions_search\`, \`sessions_read\`, \`sessions_list\`) look up earlier Claude Code and Codex sessions on this computer, when they are available to you.

- Look first when a task may continue or repeat earlier work: a follow-up, a report from a trigger or Slack about a known issue, the same game, customer, incident, pull request or error, or a request that refers to something discussed before.
- Search with two or three distinctive words (a name, an identifier, an error text) over a recent period. If a session matches, read around its match and its conclusion.
- Then build on what it found: check that it still holds, and say which session it came from. Do not repeat an investigation that is already done.
- Skip the lookup for self-contained tasks whose context is all in the request or the repository.

## Follow the owner's skills

The owner keeps their recurring ways of working as skills (\`SKILL.md\` folders in \`~/.agents/skills\`, \`~/.claude/skills\` and a project's \`.agents/skills\` or \`.claude/skills\`).

- Before you start a task, check whether one of your available skills fits it, and follow it even when the request does not name it. Tower names the skills the owner pinned at the start of its turns.
- Explicit instructions in the request and the project's own instructions come first.
- When the owner asks to keep a way of working as a skill, write \`~/.agents/skills/<name>/SKILL.md\` (or \`<project>/.agents/skills/<name>/SKILL.md\` for one project) with \`name\` and \`description\` frontmatter, and link \`~/.claude/skills/<name>\` (or \`<project>/.claude/skills/<name>\`) to that folder so both Claude Code and Codex find it.

## Ask for permissions you need

When Claude Code or Codex refuses an action the task needs (a permission rule, the auto-mode classifier, a sandbox), or keeps asking approval for it, and Tower's \`permissions_request\` tool is available to you:

- Ask the owner for the narrowest rule: a command prefix such as \`gh pr merge\`, for this project unless it is needed everywhere, and say why.
- Do not try another way around the refusal. An allowed rule applies from your next turn: say what waits on the permission and end your turn, or go on with other work first. The owner's decision can arrive as a message in this conversation; \`permissions_list\` also shows it.

## Start helper agents so Tower can tell them apart

When you run another agent for part of your work (\`claude -p\`, \`codex exec\`, a review), Tower hides it from the owner's sessions because it can see that you started it.

- Run it in the foreground, or with your tool's own background option. Never detach it from your command: no \`( … ) &\`, \`nohup\`, \`setsid\` or \`disown\`. A detached run can look like one the owner started.
- A worktree made for such runs is removed as soon as they are done; Tower also removes it by itself once the runs and your conversation have been quiet for half an hour, unless it holds changes or unpushed commits.

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
- A worktree made only to review or inspect something is removed as soon as that review is done.
- Tower also removes the worktrees a session made once the owner archives it or its automated work finishes, unless they hold uncommitted changes or unpushed commits; files git ignores are moved aside and installed dependencies go. Do not rely on that: clean up your own.
- A small change in a folder nobody else is using can be made in place.

When you finish:
- Commit only your own changes.
- Do not leave commits unpublished without saying so. Push to the branch's upstream when the project's workflow or the user expects it, never force-pushing; otherwise report which commits remain local and why.
`;
