import { useEffect, useRef, useState } from 'react';
import type { SecretBrokerAccess } from '../../../shared/secrets';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';
import { useI18n } from '../i18n/i18n';
import { secretSession } from './secrets-client';

export function SecretBrokerApproval({ token, sessionId, onChanged, onBlocked, onManage }: {
  token: string; sessionId: string; onChanged: () => void; onBlocked: (blocked: boolean) => void; onManage: () => void;
}) {
  const { t } = useI18n();
  const [access, setAccess] = useState<SecretBrokerAccess>();
  const [error, setError] = useState(''); const [loadError, setLoadError] = useState(''); const [busy, setBusy] = useState(false);
  const generation = useRef(0); const mutationVersion = useRef(0); const sending = useRef(false);
  const callbacks = useRef({ onChanged, onBlocked }); callbacks.current = { onChanged, onBlocked };
  const remote = Boolean(secretSession(sessionId).nodeId);
  useEffect(() => {
    const current = ++generation.current; const controller = new AbortController();
    setAccess(undefined); setError(''); setLoadError(''); setBusy(false); sending.current = false; callbacks.current.onBlocked(false);
    if (remote || !token) return () => { controller.abort(); generation.current++; };
    const load = async () => {
      const beforeMutation = mutationVersion.current;
      try {
        const next = await api<SecretBrokerAccess>(`/api/secrets/broker-access?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
        if (!controller.signal.aborted && generation.current === current && beforeMutation === mutationVersion.current && !sending.current) {
          setAccess(next); setLoadError(''); callbacks.current.onBlocked(next.requiresApproval && (!next.approval || !next.eligible || next.locked));
        }
      } catch {
        if (!controller.signal.aborted && generation.current === current && beforeMutation === mutationVersion.current) setLoadError(t('브로커 연결 승인 상태를 확인하지 못했습니다.'));
      }
    };
    void load(); const timer = window.setInterval(() => void load(), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); generation.current++; };
  }, [sessionId, token, remote, t]);
  const message = error || loadError;
  if (remote || (!access?.requiresApproval && !access?.approval && !message)) return null;
  if (!access) return <p role="alert" className="secret-error">{message}</p>;
  const change = async (action: 'approve-broker' | 'revoke-broker', fields: Record<string, unknown>) => {
    if (sending.current) return;
    const current = generation.current; mutationVersion.current++; sending.current = true; setBusy(true); setError('');
    try {
      const next = await api<SecretBrokerAccess>(`/api/secrets/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token },
        body: JSON.stringify({ sessionId, ...fields }),
      });
      if (generation.current !== current) return;
      setAccess(next); setLoadError(''); callbacks.current.onBlocked(next.requiresApproval && (!next.approval || !next.eligible || next.locked)); callbacks.current.onChanged();
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : t('연결 승인을 완료하지 못했습니다. 현재 상태를 확인하세요.'));
    } finally { if (generation.current === current) { sending.current = false; setBusy(false); } }
  };
  return <section className="secret-task" aria-label={t('이 작업의 브로커 연결 승인')}>
    <SecretBrokerApprovalForm access={access} busy={busy} approve={fields => void change('approve-broker', fields)} revoke={() => void change('revoke-broker', { approvalId: access.approval!.id })} />
    {message && <p role="alert" className="secret-error">{message}</p>}
    {access.locked && <button type="button" onClick={onManage}>{t('보관함 보안 설정 열기')}</button>}
  </section>;
}

export function SecretBrokerApprovalForm({ access, busy, approve, revoke }: {
  access: SecretBrokerAccess; busy: boolean; approve: (fields: Record<string, unknown>) => void; revoke: () => void;
}) {
  const { t } = useI18n(); const [taskLabel, setTaskLabel] = useState(''); const [ttlMs, setTtlMs] = useState(3_600_000);
  return <>
    <h3>{t('이 작업의 브로커 연결 승인')}</h3>
    <p>{t('에이전트가 만든 이 세션에 시크릿 브로커만 연결합니다. 사용할 키의 권한은 별도로 확인합니다.')}</p>
    <p><strong>{t('세션')}</strong> <code style={{ overflowWrap: 'anywhere' }}>{access.sessionId}</code></p>
    {access.root && <p><strong>{t('프로젝트')}</strong> <code style={{ overflowWrap: 'anywhere' }}>{access.root}</code></p>}
    {access.reason && <p role="status">{t(access.reason)}</p>}
    {access.locked && <p>{t('보관함 잠금을 해제한 뒤 연결을 승인하세요.')}</p>}
    {access.approval ? <>
      <p><strong>{t('승인한 작업')}</strong> {access.approval.taskLabel}</p>
      <p>{t('만료')} · {new Date(access.approval.expiresAt).toLocaleString()}</p>
      <p>{t('승인은 이 세션의 현재 작업에만 적용됩니다. 소유자가 시작하는 다음 턴에서 연결됩니다.')}</p>
      <button type="button" disabled={busy || access.locked} onClick={revoke}>{t('브로커 연결 승인 철회')}</button>
    </> : access.eligible && <form className="secret-form" onSubmit={event => {
      event.preventDefault(); event.stopPropagation();
      if (!busy && !access.locked && access.root && taskLabel.trim()) approve({ root: access.root, taskId: access.taskId, taskLabel: taskLabel.trim(), ttlMs });
    }}>
      <label>{t('승인할 작업')}<input required maxLength={256} value={taskLabel} disabled={busy || access.locked} onChange={event => setTaskLabel(event.target.value)} /></label>
      <label>{t('사용 시간')}<select value={ttlMs} disabled={busy || access.locked} onChange={event => setTtlMs(Number(event.target.value))}><option value={3_600_000}>{t('1시간')}</option><option value={28_800_000}>{t('8시간')}</option></select></label>
      <p>{t('로그인한 소유자만 승인할 수 있습니다. 작업 종료·만료·철회 후에는 다시 승인해야 합니다.')}</p>
      <button type="submit" disabled={busy || access.locked || !access.root || !taskLabel.trim()}>{t('이 작업에 브로커 연결 승인')}</button>
    </form>}
  </>;
}
