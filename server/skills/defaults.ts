import { ISSUE_SKILL } from '../../shared/issues.js';

/** A skill Tower makes once, as a Tower skill for every project; the owner then edits or removes it like any other. */
export interface DefaultSkill { name: string; description: string; body: string }

export const DEFAULT_SKILLS: DefaultSkill[] = [{
  name: ISSUE_SKILL,
  description: 'Use when asked to register (file) an issue for a project: analyse the request against the code, check for duplicates, and create a well-formed issue in the repository the project folder belongs to. Registers the issue only; changes no code.',
  body: `# Register an issue

Turn a short description of a bug, feature or task into a clear issue in the repository of the current project folder.
If the project's own instructions (AGENTS.md, CLAUDE.md) or its own issue skill (for example \`issue\`) say where or how
issues are filed, follow those instead of this skill.

## 1. Find the repository
- Use the remote of the folder's git repository: \`git remote get-url origin\`, or the only remote when there is no \`origin\`.
- GitHub: use \`gh\` (\`gh auth status\` must pass). GitLab: use \`glab\` with the matching commands (\`glab issue list\`,
  \`glab label list\`, \`glab issue create\`). Other hosts: do not guess.
- When there is no remote, no CLI, or no access, do not register anything: report why, with the issue text you prepared.

## 2. Analyse (read, do not guess)
- Read the project's README and agent instructions, then the code the request touches, enough to name the related
  files or modules and a direction for the work.
- Keep it short: this is an issue, not a design. Do not change, commit or push anything.

## 3. Check for duplicates
- Search open issues with a few distinctive words: \`gh issue list --state open --search "<words>"\`.
- When one already covers it, do not open another: report its link. Add a comment only when the request adds
  something new to it.

## 4. Settle what is unclear
- Do not stop to ask: the person who asked may not be watching. Make no assumptions either; register the issue and
  list what is unclear (which part of the product, expected versus current behaviour, minimal or full scope) under
  "Open questions".

## 5. Labels
- Use only labels the repository already has (\`gh label list\`): one kind (bug, enhancement, documentation, …) and,
  when the repository has them, one difficulty or priority label. Do not create labels.

## 6. Write and register
- Title: one line, starting with a verb, in the language of the request.
- Body, in the language of the request:
  - **Summary** — one or two sentences.
  - **Background / current behaviour** — what happens now, or why this is needed.
  - **Expected behaviour** — what should happen.
  - **Related code** — files, modules or services, as repository paths.
  - **Direction** — how the work could go, briefly.
  - **Done when** — checkable conditions.
  - **Open questions** — only if any.
- Never put secrets, tokens or personal data in an issue.
- \`gh issue create --title "<title>" --body-file - [--label <label> …]\` with the body on standard input (or a file
  outside the repository), so nothing is left in the working tree.

## 7. Report
The issue URL, its title and labels, and any open questions. When a duplicate was found, its link instead.
`,
}];
