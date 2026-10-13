import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, Plus, Search } from 'lucide-react';
import type { SecretSettingsItem, SecretSettingsView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { useSettingsGuard } from '../settings/SettingsPane';
import { SecretAccess, SecretPassword, type SecretChange } from './SecretAccess';
import { SecretPendingImport, SecretValueEditor } from './SecretRecovery';
import { SecretAdvanced, SecretTrustEditor, type AdvancedEditor, type SecretComputer } from './SecretAdvanced';
import { SecretSharingChips, SecretSharingEditor } from './SecretSharingEditor';
import { SecretAddForm } from './SecretAddForm';
import { isRemoteSecret, kindLabels, secretMatches, sharingSummary, type SecretCanvas } from './secrets-client';

type Editor = { type: 'add' | AdvancedEditor } | { type: 'sharing' | 'value'; id: string };

/** Settings › Secrets: one list of the saved secrets with their sharing, and the vault's rarer controls folded below. */
export function SecretSettingsWorkspace({ view, canvas, computers = [], busy, change, focus, reload }: {
  view: SecretSettingsView; canvas: SecretCanvas; computers?: SecretComputer[]; busy: boolean; change: SecretChange;
  /** Reads the view again, offered while the worker handoff is pending. */
  reload?: () => void;
  /** A secret to open the sharing editor of, asked from a chat. */
  focus?: string;
}) {
  const { t } = useI18n();
  const [editor, setEditor] = useState<Editor>(); const [query, setQuery] = useState(''); const [remove, setRemove] = useState<string>();
  const [advanced, setAdvanced] = useState(!!view.status.pendingImports);
  const focused = useRef<string | undefined>(undefined);
  const unlocked = view.status.initialized && !view.status.locked;
  useEffect(() => {
    if (!focus || focused.current === focus || !unlocked || !view.secrets.some(secret => secret.id === focus && !isRemoteSecret(secret, view.device?.id))) return;
    focused.current = focus; setEditor({ type: 'sharing', id: focus });
  }, [focus, unlocked, view]);
  const closeEditor = () => setEditor(undefined);
  useSettingsGuard({ escape: () => { if (editor) { closeEditor(); return true; } if (remove) { setRemove(undefined); return true; } return false; } });
  if (view.workerUpdatePending) return <SecretWorkerPending view={view} busy={busy} change={change} reload={reload} />;
  if (!unlocked) return <SecretAccess status={view.status} busy={busy} change={change} />;
  const item = editor && 'id' in editor ? view.secrets.find(secret => secret.id === editor.id) : undefined;
  if (editor?.type === 'add') return <SecretAddForm view={view} canvas={canvas} busy={busy} change={change} onClose={closeEditor} />;
  // Keyed by revision: after a conflicting save the editor starts again from what is stored now.
  if (editor?.type === 'sharing' && item) return <SecretSharingEditor key={`${item.id}:${item.sharing?.revision ?? 'legacy'}`} view={view} item={item} canvas={canvas} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'value' && item) return <SecretValueEditor secret={item} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'trust') return <SecretTrustEditor device={view.device} computers={computers} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'import') return <SecretPendingImport ids={view.status.pendingImportIds || []} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'password') return <SecretPassword busy={busy} change={change} onClose={closeEditor} />;
  const shown = view.secrets.filter(secret => secretMatches(secret, query));
  const removing = view.secrets.find(secret => secret.id === remove);
  return <div className="secret-workspace">
    <div className="secret-toolbar">
      <label className="secret-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t('시크릿 검색')} placeholder={t('이름이나 환경 변수 검색')} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="secret-add" disabled={busy} onClick={() => setEditor({ type: 'add' })}><Plus size={14} aria-hidden="true" />{t('시크릿 추가')}</button>
      <span className="secret-lock-state"><span className="secret-badge">{t('잠금 해제됨')}</span><button type="button" disabled={busy} onClick={() => void change('lock', {})}><LockKeyhole size={14} aria-hidden="true" />{t('잠그기')}</button></span>
    </div>
    {view.status.error && <p role="alert" className="secret-source-notice">{t('일부 시크릿 원본에 연결하지 못했습니다. 원본 컴퓨터의 연결과 잠금 상태를 확인하세요.')}</p>}
    {removing && <div className="secret-confirm" role="alertdialog" aria-label={t('시크릿을 보관함에서 삭제할까요?')}><p>{t('시크릿을 보관함에서 삭제할까요?')} <strong>{removing.name}</strong></p>
      <div className="secret-actions"><button type="button" disabled={busy} onClick={async () => { if (await change('remove', { id: removing.id })) setRemove(undefined); }}>{t('삭제')}</button><button type="button" onClick={() => setRemove(undefined)}>{t('취소')}</button></div></div>}
    {shown.length ? <ul className="secret-list">{shown.map(secret => <SecretSettingsRow key={secret.id} secret={secret} view={view} canvas={canvas} busy={busy}
      onSharing={() => setEditor({ type: 'sharing', id: secret.id })} onValue={() => setEditor({ type: 'value', id: secret.id })} onRemove={() => setRemove(secret.id)} />)}</ul>
      : <p className="secret-empty">{t(view.secrets.length ? '검색 결과가 없습니다.' : '등록한 시크릿이 없습니다.')}</p>}
    <SecretAdvanced view={view} hosts={canvas.hosts} busy={busy} change={change} open={advanced} onToggle={setAdvanced} onEdit={type => setEditor({ type })} />
  </div>;
}

/** While the attached worker predates per-secret sharing: the notice, and the vault's lock or unlock that it still serves. */
function SecretWorkerPending({ view, busy, change, reload }: { view: SecretSettingsView; busy: boolean; change: SecretChange; reload?: () => void }) {
  const { t } = useI18n(); const { status } = view;
  return <div className="secret-workspace">
    <p role="status" className="secret-source-notice">{t('새 실행 워커 적용 대기 중입니다. 진행 중인 작업이 끝나 실행 워커가 바뀌면 시크릿을 관리할 수 있습니다. 그동안은 잠금과 잠금 해제만 할 수 있습니다.')}{reload && <button type="button" disabled={busy} onClick={reload}>{t('다시 시도')}</button>}</p>
    {status.initialized && (status.locked ? <SecretAccess status={status} busy={busy} change={change} />
      : <span className="secret-lock-state"><span className="secret-badge">{t('잠금 해제됨')}</span><button type="button" disabled={busy} onClick={() => void change('lock', {})}><LockKeyhole size={14} aria-hidden="true" />{t('잠그기')}</button></span>)}
  </div>;
}

export function SecretSettingsRow({ secret, view, canvas, busy, onSharing, onValue, onRemove }: {
  secret: SecretSettingsItem; view: SecretSettingsView; canvas: SecretCanvas; busy: boolean; onSharing: () => void; onValue: () => void; onRemove: () => void;
}) {
  const { t } = useI18n();
  const remote = isRemoteSecret(secret, view.device?.id);
  return <li className="secret-item">
    <div className="secret-item-name"><strong>{secret.name}</strong><small>{t(kindLabels[secret.kind])}{secret.fields?.length ? ` · ${secret.fields.join(', ')}` : ''}</small></div>
    {/* The value slot: masked until the value view (PR3) adds show and edit here. */}
    <div className="secret-value"><span aria-hidden="true">••••••••</span><span className="sr-only">{t('값 숨김')}</span></div>
    <SecretSharingChips summary={sharingSummary(view, secret, canvas)} />
    <div className="secret-item-actions">{remote ? <span className="secret-badge">{t('원본에서 관리')}</span> : <>
      <button type="button" disabled={busy} onClick={onSharing} aria-label={t('{0} 공유 편집', { 0: secret.name })}>{t('공유 편집')}</button>
      <button type="button" disabled={busy} onClick={onValue} aria-label={t('{0} 값 교체', { 0: secret.name })}>{t('값 교체')}</button>
      <button type="button" disabled={busy} onClick={onRemove} aria-label={t('{0} 삭제', { 0: secret.name })}>{t('삭제')}</button>
    </>}</div>
  </li>;
}
