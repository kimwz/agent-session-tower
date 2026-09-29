import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { useI18n } from '../i18n/i18n';
import { markText } from './settings-sections';

/**
 * What a section may ask of the settings around it. `guard` registers what the section does before the owner moves
 * away: `escape` answers true when it handled Esc itself (closing an editor), `leave` false to keep the owner there.
 */
export interface SettingsFrame {
  /** The section is the one on screen; hidden sections keep their drafts but stop polling. */
  active: boolean;
  close(): void;
  back?: () => void;
  guard(guard: SettingsGuard | null): void;
}
export interface SettingsGuard { escape?: () => boolean; leave?: () => boolean }

export const SettingsFrameContext = createContext<SettingsFrame>({ active: true, close() {}, guard() {} });

/** Registers the section's guard for as long as it is shown; the latest handlers are always the ones asked. */
export function useSettingsGuard(guard: SettingsGuard): void {
  const frame = useContext(SettingsFrameContext);
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    frame.guard({ escape: () => latest.current.escape?.() ?? false, leave: () => latest.current.leave?.() ?? true });
    return () => frame.guard(null);
  }, [frame]);
}

export interface PaneTab<T extends string> { id: T; label: ReactNode; icon?: ReactNode; count?: number; urgent?: boolean }

/**
 * Every section of the settings has the same frame: a title with one line under it, controls of its own at the
 * right, an optional row of tabs, and the body that scrolls.
 */
export function SettingsPane<T extends string>({ title, description, scope, actions, chip, tabs, tab, onTab, children }: {
  title: ReactNode;
  description?: ReactNode;
  /** Class names older section styles hang from. */
  scope?: string;
  actions?: ReactNode;
  chip?: ReactNode;
  tabs?: readonly PaneTab<T>[];
  tab?: T;
  onTab?: (tab: T) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const frame = useContext(SettingsFrameContext);
  const id = useId();
  const moveTab = (event: KeyboardEvent) => {
    if (!tabs || !onTab || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    const index = Math.max(0, tabs.findIndex(item => item.id === tab));
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onTab(next.id);
    document.getElementById(`${id}-tab-${next.id}`)?.focus();
  };
  return <section className={`settings-pane ${scope ?? ''}`} aria-labelledby={`${id}-title`}>
    <header className="settings-pane-head">
      {frame.back && <button type="button" className="settings-back" onClick={frame.back}><ChevronLeft size={18} />{t('설정')}</button>}
      <div className="settings-pane-title">
        <h2 id={`${id}-title`}>{title}{chip}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="settings-pane-actions">{actions}</div>}
      <button type="button" className="icon-button settings-close" aria-label={t('닫기')} title={t('닫기')} onClick={frame.close}><X size={18} /></button>
    </header>
    {tabs && tabs.length > 0 && <nav className="settings-tabs" role="tablist" aria-label={typeof title === 'string' ? title : undefined} onKeyDown={moveTab}>
      {tabs.map(item => <button key={item.id} id={`${id}-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
        className={tab === item.id ? 'active' : ''} onClick={() => onTab?.(item.id)}>
        {item.icon}{item.label}{item.count ? <span className={`settings-mark ${item.urgent ? 'urgent' : ''}`}>{markText(item.count)}</span> : null}
      </button>)}
    </nav>}
    <div className="settings-pane-body" role={tabs && tabs.length > 0 ? 'tabpanel' : undefined} aria-labelledby={tabs && tabs.length > 0 && tab ? `${id}-tab-${tab}` : undefined}>{children}</div>
  </section>;
}
