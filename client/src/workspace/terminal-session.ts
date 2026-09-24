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

const requestPrefix = 'agent-monitor.workspace-terminal-request:';
/**
 * The request ID that opens a slot's shell on another computer. It is kept, across reloads too, until its answer
 * is known, so a shell whose answer was lost is the one a new try gets back.
 */
export function terminalRequest(slot: string, create: () => string): { id: string; reused: boolean } {
  const saved = savedRequest(slot);
  if (saved) return { id: saved.id, reused: true };
  const id = create();
  keepRequest(slot, { id });
  return { id, reused: false };
}
/**
 * Forgets a slot's request once the shell it asked for is known: it opened, or it ran and was closed since, or the
 * tab is closed. Any other answer, a refusal too, keeps it: the other computer remembers only requests that opened
 * a shell, so sending the same request again never opens a second one and never loses one.
 */
export function settleTerminalRequest(slot: string): void {
  try { storage()?.removeItem(requestPrefix + slot); } catch { /* Storage may be disabled. */ }
}
function savedRequest(slot: string): { id: string } | undefined {
  try {
    const saved = storage()?.getItem(requestPrefix + slot) ?? null;
    if (validId(saved)) return { id: saved };
    const parsed = JSON.parse(saved ?? 'null') as { id?: unknown } | null;
    return parsed && typeof parsed.id === 'string' && validId(parsed.id) ? { id: parsed.id } : undefined;
  } catch { return undefined; }
}
function keepRequest(slot: string, request: { id: string }): void {
  try { storage()?.setItem(requestPrefix + slot, request.id); } catch { /* In-memory only. */ }
}

/** The shell a slot reconnects to, if it has one. */
export function savedWorkspaceTerminal(slot: string): string | undefined {
  const known = ids.get(slot);
  if (known) return known;
  try { const saved = storage()?.getItem(prefix + slot) ?? null; return validId(saved) ? saved : undefined; } catch { return undefined; }
}

/** Points a new slot at an existing shell, so its tab joins that shell instead of starting one. */
export function bindWorkspaceTerminal(slot: string, id: string): void {
  if (!validId(id)) return;
  ids.set(slot, id);
  try { storage()?.setItem(prefix + slot, id); } catch { /* In-memory only. */ }
}

export function forgetWorkspaceTerminal(cwd: string, id: string): void {
  if (ids.get(cwd) === id) ids.delete(cwd);
  try { if (storage()?.getItem(prefix + cwd) === id) storage()?.removeItem(prefix + cwd); } catch { /* Storage may be disabled. */ }
}

/** `joined`: the tab shows a shell opened elsewhere; closing it leaves that shell open. */
export interface TerminalTab { key: string; number: number; joined?: true }
export const MAX_TERMINAL_TABS = 8;
const tabsPrefix = 'agent-monitor.workspace-terminal-tabs:';
const validTab = (value: unknown): value is TerminalTab => !!value && typeof value === 'object'
  && typeof (value as TerminalTab).key === 'string' && /^[a-z0-9-]{1,40}$/.test((value as TerminalTab).key)
  && Number.isInteger((value as TerminalTab).number) && (value as TerminalTab).number >= 1 && (value as TerminalTab).number <= 999
  && [undefined, true].includes((value as TerminalTab).joined);

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
