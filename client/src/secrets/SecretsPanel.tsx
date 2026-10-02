import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, LockKeyhole, X } from 'lucide-react';
import type { SecretMetadata, SecretOverview, SecretProject, SecretRule } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { SettingsFrameContext, SettingsPane, useSettingsGuard } from '../settings/SettingsPane';
import { SecretPendingImport, SecretValueEditor } from './SecretRecovery';
import { SecretAccess, SecretPassword, type SecretChange } from './SecretAccess';
import { SecretRegistration, scopeLabels, operationLabels } from './SecretRegistration';
import { SecretProjectEditor, SecretRuleEditor, SecretTrustEditor } from './SecretManagement';
import { changeSecrets, isRemoteSecret, localSecretOverview, readSecrets, secretSession } from './secrets-client';

function useSecrets(token: string, active: boolean, sessionId?: string, cwd?: string) {
  const { t } = useI18n(); const [overview, setOverview] = useState<SecretOverview>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const generation = useRef(0); const mutating = useRef(false);
  useEffect(() => { generation.current++; setOverview(undefined); setError(''); setBusy(false); mutating.current = false; }, [sessionId, token]);
  useEffect(() => {
    if (!active || !token) return;
    const controller = new AbortController(); const current = generation.current;
    const load = () => { void readSecrets(sessionId, cwd, controller.signal).then(next => { if (!controller.signal.aborted && current === generation.current && !mutating.current) { setOverview(next); setError(''); } }).catch(() => { if (!controller.signal.aborted && current === generation.current) setError(t('시크릿 보관함을 불러오지 못했습니다.')); }); };
    load(); const timer = window.setInterval(load, 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [token, active, sessionId, cwd, revision, t]);
  const change: SecretChange = useCallback(async (action, body) => {
    if (mutating.current || !active || !token) return false;
    const current = generation.current; mutating.current = true; setBusy(true); setError('');
    try {
      await changeSecrets(action, token, { ...body as Record<string, unknown>, ...secretSession(sessionId) });
      const next = await readSecrets(sessionId, cwd);
      if (current === generation.current) { setOverview(next); return true; }
      return false;
    } catch { if (current === generation.current) setError(t('시크릿 요청을 완료하지 못했습니다. 잠금 상태와 입력을 확인하세요.')); return false; }
    finally { if (current === generation.current) { mutating.current = false; setBusy(false); } }
  }, [active, token, sessionId, cwd, t]);
  return { overview, busy, error, change, reload: () => setRevision(value => value + 1) };
}

const SecretComposerContext = createContext<ReturnType<typeof useSecrets> | null>(null);
export function SecretComposerProvider({ token, sessionId, cwd, children }: { token: string; sessionId: string; cwd?: string; children: ReactNode }) {
  const state = useSecrets(token, true, sessionId, cwd);
  return <SecretComposerContext.Provider value={state}>{children}</SecretComposerContext.Provider>;
}
function useComposerSecrets() {
  const state = useContext(SecretComposerContext);
  if (!state) throw new Error('Secret composer context is missing');
  return state;
}

type Editor = { type: 'register' | 'password' | 'trust' | 'import' } | { type: 'rule'; rule?: SecretRule } | { type: 'project'; project?: SecretProject } | { type: 'update'; secret: SecretMetadata };
export function SecretWorkspace({ overview, token, sessionId, busy, change }: { overview: SecretOverview; token: string; sessionId?: string; busy: boolean; change: SecretChange }) {
  const { t } = useI18n(); const [editor, setEditor] = useState<Editor>(); const [selected, setSelected] = useState<string[]>([]); const [remove, setRemove] = useState<string>(); const [ending, setEnding] = useState(false);
  const localOverview = localSecretOverview(overview);
  const closeEditor = () => setEditor(undefined);
  useSettingsGuard({ escape: () => { if (editor) { closeEditor(); return true; } if (remove || ending) { setRemove(undefined); setEnding(false); return true; } return false; } });
  if (!overview.status.initialized || overview.status.locked) return <SecretAccess status={overview.status} busy={busy} change={change} />;
  if (editor?.type === 'register') return <SecretRegistration overview={localOverview} token={token} sessionId={sessionId} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'password') return <SecretPassword busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'project') return <SecretProjectEditor overview={overview} project={editor.project} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'trust') return <SecretTrustEditor overview={overview} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'rule') return <SecretRuleEditor overview={localOverview} rule={editor.rule} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'import') return <SecretPendingImport ids={overview.status.pendingImportIds || []} busy={busy} change={change} onClose={closeEditor} />;
  if (editor?.type === 'update' && !isRemoteSecret(editor.secret, overview.device?.id)) return <SecretValueEditor secret={editor.secret} busy={busy} change={change} onClose={closeEditor} />;
  const connected = new Set(overview.connected); const selectedIds = selected.filter(id => overview.secrets.some(secret => secret.id === id));
  const hasRemoteSelection = selectedIds.some(id => overview.secrets.some(secret => secret.id === id && isRemoteSecret(secret, overview.device?.id)));
  return <div className="secret-workspace">
    <SecretSourceNotice statusError={overview.status.error} />
    <div className="secret-actions"><button type="button" disabled={busy} onClick={() => setEditor({ type: 'register' })}>{t('시크릿 등록')}</button><button type="button" disabled={busy} onClick={() => setEditor({ type: 'password' })}>{t('비밀번호 변경')}</button><button type="button" disabled={busy} onClick={() => void change('lock', {})}><LockKeyhole size={14} />{t('보관함 잠그기')}</button></div>
    {!!overview.status.pendingImports && <section className="secret-task"><h3>{t('가져오기 대기 중')}</h3><p>{t('암호화한 시크릿 보관함의 가져오기가 대기 중입니다.')}</p><button type="button" disabled={busy || !overview.status.pendingImportIds?.length} onClick={() => setEditor({ type: 'import' })}>{t('보관함 가져오기')}</button></section>}
    {sessionId && <section className="secret-task"><h3>{t('현재 작업')}</h3><p>{t(overview.task?.status === 'open' ? '연결한 시크릿은 이 작업에서 반복 사용할 수 있습니다.' : '시크릿을 연결하면 새 보안 작업을 시작합니다.')}</p>
      <div className="secret-actions"><button type="button" disabled={busy || !selectedIds.length || hasRemoteSelection} onClick={async () => { if (hasRemoteSelection) return; if (await change('attach', { secretIds: selectedIds })) setSelected([]); }}>{t('선택한 키 연결')}</button>
        <button type="button" disabled={busy || !selectedIds.length} onClick={async () => { if (await change('revoke', { secretIds: selectedIds })) setSelected([]); }}>{t('선택한 키 권한 회수')}</button>
        <button type="button" disabled={busy || overview.task?.status !== 'open'} onClick={() => setEnding(true)}>{t('작업 종료')}</button></div>
      {hasRemoteSelection && <p>{t('원격 키의 수동 연결은 원본 컴퓨터에서 이 세션을 선택하여 승인하세요.')}</p>}
      {ending && <div className="secret-confirm"><p>{t('이번 작업의 시크릿 연결을 종료할까요?')}</p><button type="button" disabled={busy} onClick={async () => { if (await change('end-task', {})) setEnding(false); }}>{t('작업 종료')}</button><button type="button" onClick={() => setEnding(false)}>{t('취소')}</button></div>}
    </section>}
    {!overview.secrets.length && <p className="secret-empty">{t('등록한 시크릿이 없습니다.')}</p>}
    {overview.groups.map(group => {
      const keys = overview.secrets.filter(secret => secret.groupId === group.id); if (!keys.length) return null;
      return <section className="secret-group" key={group.id}><h3>{group.name}<span>{t(scopeLabels[group.scope])}{group.projectId ? ` · ${overview.projects.find(project => project.id === group.projectId)?.name || group.projectId}` : ''}</span></h3>
        <ul>{keys.map(secret => <li key={secret.id} className="secret-key"><label>{sessionId && <input type="checkbox" checked={selectedIds.includes(secret.id)} disabled={busy} onChange={event => setSelected(event.target.checked ? [...selectedIds, secret.id] : selectedIds.filter(id => id !== secret.id))} />}<span><strong>{secret.name}</strong><small>{secret.kind} · v{secret.version}{secret.fields?.length ? ` · ${secret.fields.join(', ')}` : ''}</small></span></label>
          {connected.has(secret.id) && <span className="secret-badge">{t(secret.activation === 'auto' ? '자동 연결' : '연결됨')}</span>}
          {isRemoteSecret(secret, overview.device?.id) ? <span className="secret-badge">{t('원본에서 관리')}</span> : <><button type="button" disabled={busy} onClick={() => setEditor({ type: 'update', secret })}>{t('값 교체')}</button>
          <button type="button" disabled={busy} onClick={() => setRemove(secret.id)}>{t('삭제')}</button></>}
        </li>)}</ul>
      </section>;
    })}
    {remove && <div className="secret-confirm"><p>{t('시크릿을 보관함에서 삭제할까요?')} <strong>{overview.secrets.find(secret => secret.id === remove)?.name}</strong></p><button type="button" disabled={busy} onClick={async () => { if (await change('remove', { id: remove })) setRemove(undefined); }}>{t('삭제')}</button><button type="button" onClick={() => setRemove(undefined)}>{t('취소')}</button></div>}
    <section className="secret-management"><div className="secret-section-head"><h3>{t('공유 규칙')}</h3><button type="button" disabled={busy || !localOverview.groups.length} onClick={() => setEditor({ type: 'rule' })}>{t('규칙 추가')}</button></div>
      <ul>{localOverview.rules.map(rule => <li className="secret-row" key={rule.id}><span><strong>{overview.groups.find(group => group.id === rule.groupId)?.name || rule.groupId}</strong><small>{t(rule.activation === 'auto' ? '자동' : '수동')} · {rule.operations.map(operation => t(operationLabels[operation])).join(', ')} · {overview.device?.id === rule.hostId ? overview.device.name : overview.peers.find(peer => peer.device.id === rule.hostId)?.device.name || rule.hostId}{rule.allProjects ? ` · ${t('모든 프로젝트')}` : rule.projectId ? ` · ${overview.projects.find(project => project.id === rule.projectId)?.name || rule.projectId}` : rule.root ? ` · ${rule.root}` : ''} · {t(rule.enabled ? '규칙 활성화' : '규칙 비활성화')}</small></span><button type="button" disabled={busy} onClick={() => setEditor({ type: 'rule', rule })}>{t('편집')}</button></li>)}</ul>
    </section>
    <section className="secret-management"><div className="secret-section-head"><h3>{t('프로젝트')}</h3><button type="button" disabled={busy} onClick={() => setEditor({ type: 'project' })}>{t('프로젝트 등록')}</button></div><ul>{overview.projects.map(project => <li className="secret-row" key={project.id}><span><strong>{project.name}</strong><small>{project.bindings.map(binding => `${overview.device?.id === binding.hostId ? overview.device.name : overview.peers.find(peer => peer.device.id === binding.hostId)?.device.name || binding.hostId}: ${binding.root}`).join(' · ')}</small></span><button type="button" disabled={busy} onClick={() => setEditor({ type: 'project', project })}>{t('편집')}</button></li>)}</ul></section>
    <section className="secret-management"><div className="secret-section-head"><h3>{t('승인한 시크릿 컴퓨터')}</h3><button type="button" disabled={busy} onClick={() => setEditor({ type: 'trust' })}>{t('컴퓨터 승인')}</button></div><ul>{overview.peers.map(peer => <li className="secret-row" key={peer.device.id}><span><strong>{peer.device.name}</strong><code>{peer.device.fingerprint}</code></span><button type="button" disabled={busy} onClick={() => void change('untrust', { id: peer.device.id })}>{t('승인 해제')}</button></li>)}</ul></section>
  </div>;
}

export function SecretsPanel({ token }: { token: string }) {
  const { t } = useI18n(); const frame = useContext(SettingsFrameContext); const state = useSecrets(token, frame.active);
  return <SettingsPane title={t('시크릿')} description={t('암호화한 값을 작업에 연결하고 컴퓨터와 프로젝트별 사용 권한을 정합니다.')} scope="secrets-pane">
    {state.error && <p role="alert" className="secret-error">{state.error}<button type="button" onClick={state.reload}>{t('다시 시도')}</button></p>}
    {frame.active && (state.overview ? <SecretWorkspace key={state.overview.status.locked ? 'locked' : 'open'} overview={state.overview} token={token} busy={state.busy} change={state.change} /> : <p role="status">{t('불러오는 중…')}</p>)}
  </SettingsPane>;
}

export function SecretComposer({ token, sessionId, cwd }: { token: string; sessionId: string; cwd?: string }) {
  const { t } = useI18n(); const [open, setOpen] = useState(false); const state = useComposerSecrets(); const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setOpen(false); }, [sessionId]);
  useEffect(() => {
    if (!open) return; const opener = document.activeElement as HTMLElement | null; const element = dialog.current; element?.showModal();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [open]);
  const keys = state.overview?.secrets.filter(secret => state.overview?.connected.includes(secret.id)) || [];
  return <>
    <button className="attach-button secret-composer-button" type="button" disabled={!token} aria-label={t('시크릿 연결')} title={t('시크릿 연결')} onClick={() => setOpen(true)}><KeyRound size={16} aria-hidden="true" />{!!keys.length && <span>{keys.length}</span>}</button>
    {open && createPortal(<dialog ref={dialog} className="secret-dialog" aria-label={t('시크릿 연결')} onCancel={event => { event.preventDefault(); setOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }} onClose={() => setOpen(false)}>
      <header><h2><KeyRound size={18} />{t('시크릿 연결')}</h2><button type="button" className="icon-button" aria-label={t('닫기')} onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className="secret-dialog-body">{state.error && <p role="alert" className="secret-error">{state.error}<button type="button" onClick={state.reload}>{t('다시 시도')}</button></p>}{state.overview ? <SecretWorkspace key={`${sessionId}:${state.overview.status.locked}`} overview={state.overview} token={token} sessionId={sessionId} busy={state.busy} change={state.change} /> : <p role="status">{t('불러오는 중…')}</p>}</div>
    </dialog>, document.body)}
  </>;
}
export function SecretChips({ token, sessionId, cwd }: { token: string; sessionId: string; cwd?: string }) {
  const { t } = useI18n(); const state = useComposerSecrets();
  const keys = state.overview?.secrets.filter(secret => state.overview?.connected.includes(secret.id)) || [];
  if (state.overview?.status.locked || (!keys.length && !state.overview?.status.error && !state.error)) return null;
  return <div className="secret-chips" aria-label={t('현재 작업의 시크릿')}><SecretSourceNotice statusError={state.overview?.status.error} />{keys.map(secret => <span key={secret.id}><KeyRound size={12} /><strong>{secret.name}</strong><small>{t(secret.activation === 'auto' ? '자동' : '수동')}</small><button type="button" disabled={state.busy} aria-label={`${secret.name} ${t('권한 회수')}`} onClick={() => void state.change('revoke', { secretIds: [secret.id] })}><X size={12} /></button></span>)}{state.error && <p role="alert">{state.error}</p>}</div>;
}

export function SecretSourceNotice({ statusError }: { statusError?: string }) {
  const { t } = useI18n();
  return statusError ? <p role="alert" className="secret-source-notice">{t('일부 시크릿 원본에 연결하지 못했습니다. 원본 컴퓨터의 연결과 잠금 상태를 확인하세요.')}</p> : null;
}
