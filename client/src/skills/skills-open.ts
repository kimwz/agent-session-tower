import { openSettings } from '../settings/settings-open';

/** Opens the skills from anywhere on the page, such as a project folder's menu, narrowed to that folder. */
export function openSkills(cwd?: string): boolean { return openSettings({ section: 'skills', cwd }); }
