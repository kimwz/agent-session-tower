import { useCallback, useEffect, useState } from 'react';
import type { TriggerOverview } from '../../../shared/triggers';
import type { SkillSummary } from '../../../shared/skills';
import type { PermissionOverview } from '../../../shared/permissions';
import { api } from '../common/lib';
import { permissionOperation } from '../permissions/PermissionsPanel';
import { triggerAttention } from '../triggers/trigger-helpers';
import { useControllerJoin } from '../remote/controller-join';
import type { SettingsAttention } from './settings-sections';

const PERMISSION_POLL = 20_000;
const SKILL_POLL = 60_000;

/**
 * Everything the settings mark for the owner, gathered once for the page. Permission requests hold an agent up, so
 * they are asked for more often and at once when the page comes back into view.
 */
export function useSettingsAttention(token: string, triggers: TriggerOverview | undefined, joined: { name: string; at: string } | undefined) {
  const [permissions, setPermissions] = useState(0);
  const [skills, setSkills] = useState(0);
  const join = useControllerJoin(joined);
  const refreshPermissions = useCallback(() => {
    if (!token || document.hidden) return;
    void permissionOperation<PermissionOverview>(token, 'overview').then(overview => setPermissions(overview.pending)).catch(() => {});
  }, [token]);
  const refreshSkills = useCallback(() => {
    if (!token) return;
    void api<SkillSummary>('/api/skills/summary').then(summary => setSkills(summary.proposals)).catch(() => {});
  }, [token]);
  useEffect(() => {
    refreshPermissions();
    const timer = window.setInterval(refreshPermissions, PERMISSION_POLL);
    const wake = () => { if (!document.hidden) refreshPermissions(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
  }, [refreshPermissions]);
  useEffect(() => { refreshSkills(); const timer = window.setInterval(refreshSkills, SKILL_POLL); return () => window.clearInterval(timer); }, [refreshSkills]);
  const refresh = useCallback(() => { refreshPermissions(); refreshSkills(); }, [refreshPermissions, refreshSkills]);
  const attention: SettingsAttention = { permissions, skills, triggers: triggerAttention(triggers), remote: Boolean(join.notice) };
  return { attention, refresh, join };
}
