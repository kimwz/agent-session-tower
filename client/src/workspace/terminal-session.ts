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
