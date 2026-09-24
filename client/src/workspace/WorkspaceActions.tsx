import { useOpenWorkspace } from './WorkspaceOverlay';
import { CodeXml, Terminal } from 'lucide-react';
import { translate as t, useI18n } from '../i18n/i18n';
import { localPart } from '../remote/scope';

/**
 * `machine` names the joined computer a scoped folder belongs to. `note` says why the tools are unavailable when
 * the reason is not plain from the page; the buttons then stay reachable so it can be read.
 */
export function WorkspaceActions({ cwd, token, disabled = false, note, machine }: { cwd: string; token: string; disabled?: boolean; note?: string; machine?: string }) {
  useI18n();
  const openWorkspace = useOpenWorkspace();
  const unavailable = disabled || !token || !localPart(cwd).startsWith('/');
  return <div className="workspace-actions nodrag nopan" onClick={event => event.stopPropagation()}>
    <div className="workspace-action-buttons" role="group" aria-label={t('폴더 도구')}>
      {(['editor', 'terminal'] as const).map(tool => <button type="button" key={tool} className={`project-group-action ${unavailable ? 'is-disabled' : ''}`} disabled={(unavailable && !note) || !openWorkspace} onClick={() => { if (!unavailable) openWorkspace?.(cwd, tool, machine); }} aria-disabled={unavailable} aria-description={unavailable ? note : undefined} tabIndex={unavailable && !note ? -1 : undefined} aria-label={tool === 'editor' ? t('{0} 폴더를 코드 에디터에서 열기', { 0: localPart(cwd) }) : t('{0} 폴더에서 터미널 열기', { 0: localPart(cwd) })} title={unavailable && note ? note : tool === 'editor' ? t('브라우저 코드 에디터 열기') : t('브라우저 터미널 열기')}>{tool === 'editor' ? <CodeXml size={15} /> : <Terminal size={15} />}</button>)}
    </div>
  </div>;
}
