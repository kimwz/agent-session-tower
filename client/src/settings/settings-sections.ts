/** The settings' sections, in the order the menu lists them. */
export const SETTINGS_SECTIONS = ['general', 'models', 'triggers', 'skills', 'permissions', 'decisions', 'remote', 'notifications', 'backup', 'account'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

/** What waits for the owner in the settings: counts to act on, and marks that only ask for a look. */
export interface SettingsAttention {
  /** Permission requests agents sent that wait for a decision. */
  permissions: number;
  /** Skill proposals ready to review. */
  skills: number;
  /** A trigger is paused, failing or its store cannot be read. */
  triggers: boolean;
  /** Another Tower started controlling this computer, and no tab has shown it yet. */
  remote: boolean;
}

export const noAttention: SettingsAttention = { permissions: 0, skills: 0, triggers: false, remote: false };

/** The menu's sections on this page: account management only where signing in is set up. */
export function settingsSections(account: boolean): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(section => section !== 'account' || account);
}

/** A section's own mark in the menu: a count, a dot, or nothing. */
export function sectionMark(section: SettingsSection, attention: SettingsAttention): { count?: number; urgent?: boolean; dot?: boolean } | undefined {
  if (section === 'permissions' && attention.permissions) return { count: attention.permissions, urgent: true };
  if (section === 'skills' && attention.skills) return { count: attention.skills };
  if (section === 'triggers' && attention.triggers) return { dot: true };
  if (section === 'remote' && attention.remote) return { dot: true };
  return undefined;
}

/** The settings button's mark: waiting permission requests first, since only they hold an agent up; then proposals; then a dot. */
export function entryMark(attention: SettingsAttention): { count?: number; urgent?: boolean; dot?: boolean } | undefined {
  if (attention.permissions) return { count: attention.permissions, urgent: true };
  if (attention.skills) return { count: attention.skills };
  if (attention.triggers || attention.remote) return { dot: true };
  return undefined;
}

/** Where the settings open: the section asked for, else a waiting permission request, else where the owner last was. */
export function initialSection(requested: SettingsSection | undefined, attention: SettingsAttention, last: SettingsSection | undefined, sections: readonly SettingsSection[]): SettingsSection {
  if (requested && sections.includes(requested)) return requested;
  if (attention.permissions) return 'permissions';
  if (last && sections.includes(last)) return last;
  return 'general';
}

/** Whether this page can show what was asked: signed in to the page, a section it has, account management only on the computer itself. */
export function requestAllowed(page: { token: string; sections: readonly SettingsSection[]; local: boolean }, section: SettingsSection | undefined): boolean {
  if (!page.token) return false;
  if (section && !page.sections.includes(section)) return false;
  return section !== 'account' || page.local;
}

export const markText = (count: number) => count > 9 ? '9+' : String(count);
