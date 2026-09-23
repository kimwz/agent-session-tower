const prefix = 'agent-monitor.workspace-terminal:';
const ids = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const validId = (value: string | null): value is string => !!value && /^[0-9a-f-]{36}$/.test(value);
const storage = () => { try { return window.sessionStorage; } catch { return undefined; } };

/** Retain terminal identity across page reloads, and coalesce React effect remounts. */
export async function workspaceTerminalSession(cwd: string, resume: (id: string) => Promise<void>, create: () => Promise<string>): Promise<string> {
  const active = pending.get(cwd);
  if (active) return active;
  const operation = (async () => {
    let id = ids.get(cwd);
    try { const saved = storage()?.getItem(prefix + cwd) ?? null; if (validId(saved)) id = saved; } catch { /* In-memory fallback. */ }
    if (id) {
      try { await resume(id); ids.set(cwd, id); return id; }
      catch (error) {
        if (![404, 409].includes((error as { status?: number }).status ?? 0)) throw error;
        forgetWorkspaceTerminal(cwd, id);
      }
    }
    id = await create();
    ids.set(cwd, id);
    try { storage()?.setItem(prefix + cwd, id); } catch { /* In-memory fallback. */ }
    return id;
  })();
  pending.set(cwd, operation);
  try { return await operation; } finally { if (pending.get(cwd) === operation) pending.delete(cwd); }
}

export function forgetWorkspaceTerminal(cwd: string, id: string): void {
  if (ids.get(cwd) === id) ids.delete(cwd);
  try { if (storage()?.getItem(prefix + cwd) === id) storage()?.removeItem(prefix + cwd); } catch { /* Storage may be disabled. */ }
}

export interface TerminalTab { key: string; number: number }
export const MAX_TERMINAL_TABS = 8;
const tabsPrefix = 'agent-monitor.workspace-terminal-tabs:';
const validTab = (value: unknown): value is TerminalTab => !!value && typeof value === 'object'
  && typeof (value as TerminalTab).key === 'string' && /^[a-z0-9-]{1,40}$/.test((value as TerminalTab).key)
  && Number.isInteger((value as TerminalTab).number) && (value as TerminalTab).number >= 1 && (value as TerminalTab).number <= 999;

/** The first tab keeps the pre-tab storage slot, so a shell opened before an upgrade reconnects. */
export function terminalSlot(cwd: string, tab: TerminalTab): string { return tab.key === 'main' ? cwd : `${cwd}\u0000${tab.key}`; }

export function readTerminalTabs(cwd: string): TerminalTab[] {
  try {
    const saved: unknown = JSON.parse(storage()?.getItem(tabsPrefix + cwd) ?? 'null');
    if (Array.isArray(saved) && saved.length <= MAX_TERMINAL_TABS && saved.every(validTab) && new Set(saved.map(tab => tab.key)).size === saved.length) return saved;
  } catch { /* Fall back to one tab. */ }
  return [{ key: 'main', number: 1 }];
}

export function saveTerminalTabs(cwd: string, tabs: readonly TerminalTab[]): void {
  try { storage()?.setItem(tabsPrefix + cwd, JSON.stringify(tabs)); } catch { /* Tabs then last only for this page. */ }
}

export function nextTerminalTab(tabs: readonly TerminalTab[]): TerminalTab {
  return { key: crypto.randomUUID().slice(0, 8), number: Math.max(0, ...tabs.map(tab => tab.number)) + 1 };
}
