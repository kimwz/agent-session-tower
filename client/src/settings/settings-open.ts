import type { SettingsSection } from './settings-sections';

/**
 * A request to show the settings: which section, for skills or permissions the folder to narrow them to, and for
 * secrets the secret whose sharing to edit.
 */
export interface SettingsRequest { section?: SettingsSection; cwd?: string; secretId?: string }

/** What the opened settings keep of a request besides its section; a `cwd` present but undefined clears the folder. */
export function requestPlace(request: SettingsRequest): { cwd?: string; secretId?: string } {
  return { ...('cwd' in request ? { cwd: request.cwd } : {}), ...(request.secretId ? { secretId: request.secretId } : {}) };
}

/** Answers whether the page could show the section asked for; false when it cannot right now. */
type Listener = (request: SettingsRequest) => boolean;
const listeners = new Set<Listener>();

/** Opens the settings from anywhere on the page: a folder's menu, the master agent, a notice. */
export function openSettings(request: SettingsRequest = {}): boolean {
  let shown = false;
  for (const listener of listeners) shown = listener(request) || shown;
  return shown;
}

export function onOpenSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
