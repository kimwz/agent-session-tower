/** The Tower skill that registers an issue; Tower makes it once, and the owner can edit it in the Skills panel. */
export const ISSUE_SKILL = 'register-issue';
/** Longest issue description the folder's issue button sends. */
export const MAX_ISSUE_TEXT = 8_000;

/**
 * The first request of a session that registers an issue in the repository of its folder. The folder's issue button
 * and the master agent both start that session with it, so they behave the same. It names the skill and carries the
 * essentials in case the skill is missing, as on a computer running an older Tower.
 */
export function issueRequest(text: string): string {
  return [
    `Register the issue below in the repository this folder belongs to, following the ${ISSUE_SKILL} skill.`,
    'If this project has its own issue skill or instructions for filing issues, follow those instead.',
    `Without the skill: find the repository from the git remote, read the related code, check open issues for a duplicate (link it instead of opening another), and create the issue with a clear title and a body (summary, current and expected behaviour, related code, direction, done when, open questions), using only labels the repository already has.`,
    'Do not stop to ask: list anything unclear under open questions. Do not change, commit or push code. Report the issue URL when done.',
    '',
    'Issue:',
    text.trim(),
  ].join('\n');
}
