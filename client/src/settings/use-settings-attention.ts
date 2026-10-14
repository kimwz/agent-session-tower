import { useCallback, useEffect, useState } from 'react';
import type { TriggerOverview } from '../../../shared/triggers';
import type { SkillSummary } from '../../../shared/skills';
import type { PermissionOverview } from '../../../shared/permissions';
import { api } from '../common/lib';
import { permissionOperation } from '../permissions/PermissionsPanel';
import type { TriggerComputer } from '../triggers/TriggerPanel';
import { triggerAttention, triggerProblems } from '../triggers/trigger-helpers';
import { useSeenTriggerProblems } from '../triggers/seen-trigger-problems';
import { useControllerJoin } from '../remote/controller-join';
import { publishSkillSummary } from '../skills/skills-open';
import type { SettingsAttention } from './settings-sections';

const PERMISSION_POLL = 20_000;
const SKILL_POLL = 60_000;

/**
 * Everything the settings mark for the owner, gathered once for the page. Permission requests hold an agent up, so
 * they are asked for more often and at once when the page comes back into view: this computer's, and those of the
 * joined computers that follow this Tower, whose mirrored state carries no permission requests (a controller's view
 * leaves them out), so each is asked through its link as this computer is, only while it is connected and following.
 */
export function useSettingsAttention(token: string, triggers: TriggerOverview | undefined, joined: { name: string; at: string } | undefined, computers: readonly TriggerComputer[] = []) {
  const [permissions, setPermissions] = useState(0);
  const [remote, setRemote] = useState<Readonly<Record<string, number>>>({});
  const [skills, setSkills] = useState(0);
  const join = useControllerJoin(joined);
  const seenTriggers = useSeenTriggerProblems();
  const following = computers.filter(item => item.permissions).map(item => item.node).sort().join(',');
  const refreshPermissions = useCallback(() => {
    const nodes = following ? following.split(',') : [];
    setRemote(counts => Object.fromEntries(Object.entries(counts).filter(([node]) => nodes.includes(node))));
    if (!token || document.hidden) return;
    // best-effort: a count that cannot be read now keeps the last one; the next look asks again.
    void permissionOperation<PermissionOverview>(token, 'overview').then(overview => setPermissions(overview.pending)).catch(() => {});
    // best-effort: a computer that cannot answer now keeps its last count until it can, or stops following.
    for (const node of nodes) void permissionOperation<PermissionOverview>(token, 'overview', {}, node).then(overview => setRemote(counts => ({ ...counts, [node]: overview.pending }))).catch(() => {});
  }, [token, following]);
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
  const attention: SettingsAttention = { permissions: permissions + Object.values(remote).reduce((sum, count) => sum + count, 0), permissionsOn: remote, skills,
    triggers: triggerAttention(triggers, seenTriggers.seen), remote: Boolean(join.notice) };
  // Only this page's own overview forgets problems that went away; another tab's write is taken as it is.
  const { forgetGone } = seenTriggers;
  useEffect(() => { if (triggers) forgetGone(triggerProblems(triggers)); }, [triggers, forgetGone]);
  // Seeing the triggers needs their overview; before it arrives there is nothing to remember. It changes only with this
  // page's overview, not with what another tab saw: a tab whose overview is behind must not write back a problem
  // another tab saw go away, or the same problem coming back would not ask again.
  const { acknowledge } = seenTriggers;
  const acknowledgeTriggers = useCallback(() => { if (triggers) acknowledge(triggerProblems(triggers)); }, [triggers, acknowledge]);
  return { attention, refresh, join, acknowledgeTriggers };
}
