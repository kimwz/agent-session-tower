import { memo, useEffect, useMemo, useRef } from 'react';
import { GitBranch } from 'lucide-react';
import type { Session } from '../../shared/types';
import { getSessionFamily } from './session-family';
import { sessionTitle, statusLabels } from './lib';

let pendingNavigationFocus: string | undefined;

export const SessionFamilyNav = memo(function SessionFamilyNav({ sessions, selectedId, onNavigate }: {
  sessions: Session[];
  selectedId: string;
  onNavigate: (id: string) => void;
}) {
  const family = useMemo(() => getSessionFamily(sessions, selectedId), [sessions, selectedId]);
  const selection = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (pendingNavigationFocus === selectedId) {
      pendingNavigationFocus = undefined;
      selection.current?.focus({ preventScroll: true });
    }
  }, [selectedId]);
  if (!family.root || family.members.length < 2) return null;
  return <nav className="session-family-nav" aria-label="서브에이전트 탐색">
    <GitBranch size={12} /><span>서브 {family.members.length - 1}</span>
    <select ref={selection} aria-label="에이전트 대화 선택" value={selectedId} onChange={event => { pendingNavigationFocus = event.target.value; onNavigate(event.target.value); }}>
      {family.members.map((member, index) => <option key={member.id} value={member.id}>{index === 0 ? '부모 대화' : sessionTitle(member)}{member.status === 'working' ? ` · ${statusLabels[member.status]}` : ''}</option>)}
    </select>
  </nav>;
});
