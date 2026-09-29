/** Opens the permissions panel from anywhere on the page, such as a project folder's menu; the header button shows it. */
const listeners = new Set<(cwd?: string) => void>();

export function openPermissions(cwd?: string): void { for (const listener of listeners) listener(cwd); }

export function onOpenPermissions(listener: (cwd?: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
