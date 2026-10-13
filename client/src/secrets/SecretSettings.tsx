import { useEffect, useRef, useState } from 'react';
import { EyeOff, LockKeyhole, Plus, Search } from 'lucide-react';
import type { SecretSettingsItem, SecretSettingsView, SecretValue } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { useSettingsGuard } from '../settings/SettingsPane';
import { SecretAccess, SecretPassword, type SecretChange } from './SecretAccess';
import { SecretPendingImport } from './SecretRecovery';
import { SecretValueCell, SecretValueForm, SecretValuePanel, type ValueControls, type ValueSlot } from './SecretValueView';
import { SecretAdvanced, SecretTrustEditor, type AdvancedEditor, type SecretComputer } from './SecretAdvanced';
import { SecretSharingChips, SecretSharingEditor } from './SecretSharingEditor';
import { SecretAddForm } from './SecretAddForm';
import { isRemoteSecret, kindLabels, secretMatches, sharingSummary, type SecretCanvas } from './secrets-client';

type Editor = { type: 'add' | AdvancedEditor } | { type: 'sharing'; id: string };
/** Reads one saved value for the owner's value view; undefined once refused (the settings say why). */
export type SecretReveal = (secretId: string, expectedVersion: number) => Promise<SecretValue | undefined>;

/** Settings › Secrets: one list of the saved secrets with their sharing, and the vault's rarer controls folded below. */
export function SecretSettingsWorkspace({ view, canvas, computers = [], busy, change, reveal, focus, reload }: {
  view: SecretSettingsView; canvas: SecretCanvas; computers?: SecretComputer[]; busy: boolean; change: SecretChange;
  /** Reads a value for the owner's view; without it values stay masked. */
  reveal?: SecretReveal;
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
  const [slot, setSlot] = useState<ValueSlot>(); const reads = useRef(0);
  // A read value stays only while value viewing is on and the secret is still at that version. When viewing ends
  // elsewhere the slot stays open without its value, so the Tower password is asked for again right there.
  useEffect(() => {
    setSlot(current => {
      if (!current?.value) return current;
      if (!view.valueView) return { id: current.id, edit: current.edit };
      return view.secrets.some(secret => secret.id === current.id && secret.version === current.value?.version) ? current : undefined;
    });
  }, [view]);
  // Reads the asked value once viewing is on, at the version this view shows; a later open or close drops the answer.
  useEffect(() => {
    if (!slot?.want || !view.valueView) return;
    const { id, edit } = slot; const secret = view.secrets.find(entry => entry.id === id); const ticket = ++reads.current;
    if (!secret || !reveal) { setSlot(undefined); return; }
    setSlot({ id, edit, loading: true });
    void reveal(secret.id, secret.version).then(value => { if (ticket === reads.current) setSlot(value ? { id, edit, value } : { id, edit }); });
  }, [slot, view, reveal]);
  const values: ValueControls = {
    slot, valueView: !!view.valueView,
    // Showing then editing the same value needs no second read.
    open: (secret, edit) => { reads.current++; setSlot(current => current?.id === secret.id && current.value ? { ...current, edit } : { id: secret.id, edit, want: !!view.valueView }); },
    close: () => { reads.current++; setSlot(undefined); },
    unlock: async password => { if (await change('view-unlock', { password })) setSlot(current => current && { id: current.id, edit: current.edit, want: true }); },
  };
  const closeEditor = () => setEditor(undefined);
  const openEditor = (next: Editor) => { values.close(); setEditor(next); };
  useSettingsGuard({ escape: () => {
    if (editor) { closeEditor(); return true; }
    if (slot) { values.close(); return true; }
    if (remove) { setRemove(undefined); return true; }
    return false;
  } });
  if (view.workerUpdatePending) return <SecretWorkerPending view={view} busy={busy} change={change} reload={reload} />;
  if (!unlocked) return <SecretAccess status={view.status} busy={busy} change={change} />;
  const item = editor && 'id' in editor ? view.secrets.find(secret => secret.id === editor.id) : undefined;
  if (editor?.type === 'add') return <SecretAddForm view={view} canvas={canvas} busy={busy} change={change} onClose={closeEditor} />;
  // Keyed by revision: after a conflicting save the editor starts again from what is stored now.
  if (editor?.type === 'sharing' && item) return <SecretSharingEditor key={`${item.id}:${item.sharing?.revision ?? 'legacy'}`} view={view} item={item} canvas={canvas} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'trust') return <SecretTrustEditor device={view.device} computers={computers} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'import') return <SecretPendingImport ids={view.status.pendingImportIds || []} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'password') return <SecretPassword busy={busy} change={change} onClose={closeEditor} />;
  const editing = slot?.edit && slot.value && view.valueView ? view.secrets.find(secret => secret.id === slot.id && secret.version === slot.value?.version) : undefined;
  if (editing && slot?.value) return <SecretValueForm key={`${editing.id}:${editing.version}`} secret={editing} value={slot.value} busy={busy} change={change} onClose={values.close} />;
  const shown = view.secrets.filter(secret => secretMatches(secret, query));
  const removing = view.secrets.find(secret => secret.id === remove);
  return <div className="secret-workspace">
    <div className="secret-toolbar">
      <label className="secret-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t('시크릿 검색')} placeholder={t('이름이나 환경 변수 검색')} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className="secret-add" disabled={busy} onClick={() => openEditor({ type: 'add' })}><Plus size={14} aria-hidden="true" />{t('시크릿 추가')}</button>
      <span className="secret-lock-state">
        {view.valueView && <button type="button" disabled={busy} onClick={() => { values.close(); void change('view-lock', {}); }}><EyeOff size={14} aria-hidden="true" />{t('값 보기 잠그기')}</button>}
        <span className="secret-badge">{t('잠금 해제됨')}</span><button type="button" disabled={busy} onClick={() => void change('lock', {})}><LockKeyhole size={14} aria-hidden="true" />{t('잠그기')}</button></span>
    </div>
    {view.status.error && <p role="alert" className="secret-source-notice">{t('일부 시크릿 원본에 연결하지 못했습니다. 원본 컴퓨터의 연결과 잠금 상태를 확인하세요.')}</p>}
    {removing && <div className="secret-confirm" role="alertdialog" aria-label={t('시크릿을 보관함에서 삭제할까요?')}><p>{t('시크릿을 보관함에서 삭제할까요?')} <strong>{removing.name}</strong></p>
      <div className="secret-actions"><button type="button" disabled={busy} onClick={async () => { if (await change('remove', { id: removing.id })) setRemove(undefined); }}>{t('삭제')}</button><button type="button" onClick={() => setRemove(undefined)}>{t('취소')}</button></div></div>}
    {shown.length ? <ul className="secret-list">{shown.map(secret => <SecretSettingsRow key={secret.id} secret={secret} view={view} canvas={canvas} busy={busy} values={values}
      onSharing={() => openEditor({ type: 'sharing', id: secret.id })} onRemove={() => setRemove(secret.id)} />)}</ul>
      : <p className="secret-empty">{t(view.secrets.length ? '검색 결과가 없습니다.' : '등록한 시크릿이 없습니다.')}</p>}
    <SecretAdvanced view={view} hosts={canvas.hosts} busy={busy} change={change} open={advanced} onToggle={setAdvanced} onEdit={type => openEditor({ type })} />
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

export function SecretSettingsRow({ secret, view, canvas, busy, values, onSharing, onRemove }: {
  secret: SecretSettingsItem; view: SecretSettingsView; canvas: SecretCanvas; busy: boolean; values: ValueControls; onSharing: () => void; onRemove: () => void;
}) {
  const { t } = useI18n();
  const remote = isRemoteSecret(secret, view.device?.id);
  const slot = values.slot?.id === secret.id ? values.slot : undefined;
  return <li className="secret-item">
    <div className="secret-item-name"><strong>{secret.name}</strong><small>{t(kindLabels[secret.kind])}{secret.fields?.length ? ` · ${secret.fields.join(', ')}` : ''}</small></div>
    <SecretValueCell secret={secret} slot={slot} remote={remote} busy={busy} values={values} />
    <SecretSharingChips summary={sharingSummary(view, secret, canvas)} />
    <div className="secret-item-actions">{remote ? <span className="secret-badge">{t('원본에서 관리')}</span> : <>
      <button type="button" disabled={busy} onClick={onSharing} aria-label={t('{0} 공유 편집', { 0: secret.name })}>{t('공유 편집')}</button>
      <button type="button" disabled={busy} onClick={onRemove} aria-label={t('{0} 삭제', { 0: secret.name })}>{t('삭제')}</button>
    </>}</div>
    {/* Last, so it spans the row's full width below it. */}
    {slot && !remote && <SecretValuePanel secret={secret} slot={slot} valueView={!!view.valueView} busy={busy} onUnlock={values.unlock} onClose={values.close} />}
  </li>;
}
