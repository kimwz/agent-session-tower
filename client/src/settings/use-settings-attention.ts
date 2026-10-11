import { useCallback, useEffect, useState } from 'react';
import type { TriggerOverview } from '../../../shared/triggers';
import type { SkillSummary } from '../../../shared/skills';
import type { PermissionOverview } from '../../../shared/permissions';
import { api } from '../common/lib';
import { permissionOperation } from '../permissions/PermissionsPanel';
import { triggerAttention, triggerProblems } from '../triggers/trigger-helpers';
import { useSeenTriggerProblems } from '../triggers/seen-trigger-problems';
import { useControllerJoin } from '../remote/controller-join';
import { publishSkillSummary } from '../skills/skills-open';
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
  const seenTriggers = useSeenTriggerProblems();
  const refreshPermissions = useCallback(() => {
    if (!token || document.hidden) return;
    void permissionOperation<PermissionOverview>(token, 'overview').then(overview => setPermissions(overview.pending)).catch(() => {});
  }, [token]);
  const refreshSkills = useCallback(() => {
    if (!token) return;
    void api<SkillSummary>('/api/skills/summary').then(summary => { setSkills(summary.proposals); publishSkillSummary(summary); }).catch(() => { setSkills(0); publishSkillSummary({ proposals: 0 }); });
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
  const attention: SettingsAttention = { permissions, skills, triggers: triggerAttention(triggers, seenTriggers.seen), remote: Boolean(join.notice) };
  // Only this page's own overview forgets problems that went away; another tab's write is taken as it is.
  const { forgetGone } = seenTriggers;
  useEffect(() => { if (triggers) forgetGone(triggerProblems(triggers)); }, [triggers, forgetGone]);
  // Seeing the triggers needs their overview; before it arrives there is nothing to remember. Problems seen already
  // are not written again on every overview the triggers' panel shows.
  const acknowledgeTriggers = useCallback(() => { if (attention.triggers && triggers) seenTriggers.acknowledge(triggerProblems(triggers)); },
    [attention.triggers, triggers, seenTriggers.acknowledge]);
  return { attention, refresh, join, acknowledgeTriggers };
}
