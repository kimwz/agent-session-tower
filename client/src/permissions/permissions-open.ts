import { openSettings } from '../settings/settings-open';

/** Opens the permissions from anywhere on the page, such as a project folder's menu, narrowed to that folder. */
export function openPermissions(cwd?: string): boolean { return openSettings({ section: 'permissions', cwd }); }
