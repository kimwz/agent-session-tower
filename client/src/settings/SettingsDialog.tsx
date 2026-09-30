import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, Bell, BrainCircuit, ChevronRight, Network, ShieldCheck, SlidersHorizontal, Sparkles, UserRoundCog, X, Zap, type LucideIcon } from 'lucide-react';
import type { ProviderHealth, Session } from '../../../shared/types';
import type { TriggerOverview } from '../../../shared/triggers';
import { useI18n } from '../i18n/i18n';
import { useMediaQuery } from '../common/use-media-query';
import { useCanvasControls } from '../graph/canvas-controls-store';
import { TriggerPanel, type TriggerComputer, type TriggerTargets } from '../triggers/TriggerPanel';
import { SlackPanel } from '../slack/SlackPanel';
import { PublicAgentsPanel } from '../triggers/PublicAgentsPanel';
import { SkillsPanel } from '../skills/SkillsPanel';
import { PermissionsPanel } from '../permissions/PermissionsPanel';
import { DecisionPanel } from '../decisions/DecisionPanel';
import { RemotePanel, type RemoteTab } from '../remote/RemotePanel';
import { NotificationPanel } from '../notifications/NotificationPanel';
import { AccountSection } from '../auth/AccountPanel';
import { GeneralSettings } from './GeneralSettings';
import { BackupPanel } from '../backup/BackupPanel';
import { SettingsFrameContext, type SettingsFrame, type SettingsGuard } from './SettingsPane';
import { markText, sectionMark, type SettingsAttention, type SettingsSection } from './settings-sections';

/** What the sections need from the page. */
export interface SettingsContext {
  token: string;
  triggers?: TriggerOverview;
  providers: ProviderHealth[];
  /** Folders of this computer, with their names. */
  projects: [string, string][];
  sessions: Session[];
  computers: TriggerComputer[];
  targets: TriggerTargets;
  controlledBy: string[];
  showHidden: boolean;
  onShowHiddenChange: (showHidden: boolean) => void;
  onOpenSession: (id: string) => void;
}

export interface SettingsPlace { section: SettingsSection; cwd?: string; remoteTab?: RemoteTab; list?: boolean }

const ICONS: Record<SettingsSection, LucideIcon> = { general: SlidersHorizontal, triggers: Zap, skills: Sparkles, permissions: ShieldCheck, decisions: BrainCircuit, remote: Network, notifications: Bell, backup: ArchiveRestore, account: UserRoundCog };
const GROUPS: { caption?: string; sections: SettingsSection[] }[] = [
  { sections: ['general'] },
  { caption: '자동화', sections: ['triggers', 'skills', 'permissions', 'decisions'] },
  { caption: '연결', sections: ['remote', 'notifications'] },
  { caption: '데이터', sections: ['backup'] },
  { sections: ['account'] },
];

export function sectionLabel(section: SettingsSection, t: (key: string) => string): string {
  const labels: Record<SettingsSection, string> = { general: '일반', triggers: '트리거', skills: '스킬', permissions: '권한', decisions: '빠른 판단', remote: '원격 컴퓨터', notifications: '알림', backup: '백업', account: '계정' };
  return t(labels[section]);
}

/**
 * Every setting of Tower in one dialog: the sections on the left, the chosen one on the right. A section once shown
 * stays mounted, hidden, while the dialog is open, so moving between sections keeps what was being written.
 */
export function SettingsDialog({ place, sections, attention, context, onPlace, onChanged, onClose }: {
  place: SettingsPlace;
  sections: readonly SettingsSection[];
  attention: SettingsAttention;
  context: SettingsContext;
  onPlace: (place: SettingsPlace) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const mobile = useMediaQuery('(max-width: 680px)');
  const canvas = useCanvasControls();
  const [visited, setVisited] = useState<SettingsSection[]>(() => [place.section]);
  const [slack, setSlack] = useState(false);
  const [publicAgents, setPublicAgents] = useState(false);
  const guards = useRef(new Map<SettingsSection, SettingsGuard>());
  const current = place.section;
  const listing = mobile && !!place.list;
  // The folder skills and permissions were narrowed to stays with them while the owner visits other sections.
  const [folders, setFolders] = useState<Partial<Record<SettingsSection, string>>>(() => ({ [place.section]: place.cwd }));
  useEffect(() => { if ('cwd' in place) setFolders(value => ({ ...value, [place.section]: place.cwd })); }, [place]);

  useEffect(() => { setVisited(shown => shown.includes(current) ? shown : [...shown, current]); }, [current]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  // Closing asks every section that has something unsaved, not only the one on screen.
  const mayLeave = useCallback(() => [...guards.current.values()].every(guard => !guard.leave || guard.leave()), []);
  const requestClose = useCallback(() => { if (mayLeave()) onClose(); }, [mayLeave, onClose]);
  const back = useCallback(() => onPlace({ ...place, list: true }), [onPlace, place]);
  const frames = useMemo(() => new Map(sections.map(section => [section, {
    active: section === current && !listing,
    close: requestClose,
    ...(mobile ? { back } : {}),
    guard: (guard: SettingsGuard | null) => { if (guard) guards.current.set(section, guard); else guards.current.delete(section); },
  } satisfies SettingsFrame])), [sections, current, listing, requestClose, mobile, back]);

  const choose = (section: SettingsSection) => onPlace({ section });
  // A conversation opened from a section is looked at without the settings over it.
  const openSession = (id: string) => { if (!mayLeave()) return; onClose(); context.onOpenSession(id); };
  const body = (section: SettingsSection): ReactNode => {
    const cwd = folders[section];
    const clearFolder = () => onPlace({ section, cwd: undefined });
    switch (section) {
      case 'general': return <GeneralSettings canvas={canvas} showHidden={context.showHidden} onShowHiddenChange={context.onShowHiddenChange} />;
      case 'triggers': return <TriggerPanel token={context.token} overview={context.triggers} providers={context.providers} projects={context.projects} sessions={context.sessions}
        computers={context.computers} targets={context.targets} onOpenSlack={() => setSlack(true)} onOpenPublic={() => setPublicAgents(true)} />;
      case 'skills': return <SkillsPanel token={context.token} cwd={cwd} projects={context.projects.map(([key]) => key)} onClearFolder={clearFolder} onChanged={onChanged} onOpenSession={openSession} />;
      case 'permissions': return <PermissionsPanel token={context.token} cwd={cwd} projects={context.projects.map(([key]) => key)} pending={attention.permissions} onClearFolder={clearFolder} onChanged={onChanged} onOpenSession={openSession} />;
      case 'decisions': return <DecisionPanel token={context.token} />;
      case 'remote': return <RemotePanel token={context.token} projects={context.projects} controlledBy={context.controlledBy} initialTab={place.remoteTab} />;
      case 'notifications': return <NotificationPanel token={context.token} />;
      case 'backup': return <BackupPanel token={context.token} />;
      case 'account': return <AccountSection />;
    }
  };

  return createPortal(<dialog ref={dialog} className="settings-dialog" aria-label={t('설정')}
    onCancel={event => {
      // Slack's and the public agents' own dialogs sit above this one and answer their own Esc; React hands it on.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (!listing && guards.current.get(current)?.escape?.()) return;
      requestClose();
    }}
    // The browser may close a modal on its own (a second Esc without a click in between); the page follows it.
    // A close queued before the dialog opened again (React's development double mount) is not one.
    onClose={event => { if (event.target === event.currentTarget && !event.currentTarget.open) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <div className={`settings-shell ${listing ? 'listing' : 'reading'}`}>
      <nav className="settings-nav" aria-label={t('설정 메뉴')}>
        <div className="settings-nav-head"><h2>{t('설정')}</h2><button type="button" className="icon-button settings-nav-close" aria-label={t('닫기')} title={t('닫기')} onClick={requestClose}><X size={18} /></button></div>
        {GROUPS.map((group, index) => {
          const shown = group.sections.filter(section => sections.includes(section));
          if (!shown.length) return null;
          return <div key={index} className={`settings-nav-group ${group.sections.includes('account') ? 'settings-nav-foot' : ''}`}>
            {group.caption && <h3>{t(group.caption)}</h3>}
            {shown.map(section => {
              const Icon = ICONS[section];
              const mark = sectionMark(section, attention);
              return <button key={section} type="button" className={section === current && !listing ? 'selected' : ''} aria-current={section === current && !listing ? 'page' : undefined} onClick={() => choose(section)}>
                <Icon size={16} /><span>{sectionLabel(section, t)}</span>
                {mark?.count ? <span className={`settings-mark ${mark.urgent ? 'urgent' : ''}`}>{markText(mark.count)}</span> : mark?.dot ? <i className="settings-dot" aria-label={t('확인 필요')} /> : null}
                <ChevronRight className="settings-nav-chevron" size={15} aria-hidden="true" />
              </button>;
            })}
          </div>;
        })}
      </nav>
      <div className="settings-main">
        {visited.filter(section => sections.includes(section)).map(section => <SettingsFrameContext.Provider key={section} value={frames.get(section)!}>
          <div className="settings-section" hidden={section !== current || listing}>{body(section)}</div>
        </SettingsFrameContext.Provider>)}
      </div>
    </div>
    {slack && <SlackPanel providers={context.providers} projects={context.projects} token={context.token} onClose={() => setSlack(false)} />}
    {publicAgents && <PublicAgentsPanel token={context.token} providers={context.providers} projects={context.projects} onClose={() => setPublicAgents(false)} />}
  </dialog>, document.body);
}
