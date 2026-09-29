import type { SettingsSection } from './settings-sections';

/** A request to show the settings: which section, and for skills or permissions the folder to narrow them to. */
export interface SettingsRequest { section?: SettingsSection; cwd?: string }

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
