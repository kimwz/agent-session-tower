/**
 * A GitHub issue's address as a todo's whole title: adding such a todo brings that issue in as a linked todo
 * (server/todo/github/sync.ts `importIssue`). Words around the address leave it an ordinary todo.
 */

/** The same repository names the links take (server/todo/github/bindings.ts `REPO`). */
const ADDRESS = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/issues\/(\d{1,9})\/?(?:[?#]\S*)?$/i;

export interface GitHubIssueAddress { repo: string; number: number }

export function githubIssueAddress(text: string): GitHubIssueAddress | undefined {
  const found = ADDRESS.exec(text.trim());
  if (!found) return undefined;
  const number = Number(found[2]);
  return number > 0 ? { repo: found[1], number } : undefined;
}
