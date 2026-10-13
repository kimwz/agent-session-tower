import { useState } from 'react';
import { KeyRound, Link2, Plus, RotateCcw, Search, Settings2, Unlink } from 'lucide-react';
import type { SecretBasis, SecretSessionError, SecretSessionView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { relativeTime } from '../common/lib';
import { SecretAccess, type SecretChange } from './SecretAccess';
import { kindLabels, secretMatches, usedSecrets } from './secrets-client';

const basisLabels: Record<SecretBasis, string> = { global: 'GLOBAL', folder: '이 폴더', session: '이 세션', legacy: '기존 규칙', remote: '원격 원본' };
const stateLabels: Record<SecretSessionError, [string, string]> = {
  uninitialized: ['보관함 없음', '시크릿 보관함이 아직 없습니다. 비밀번호를 정해 만들면 시크릿을 연결할 수 있습니다.'],
  locked: ['잠김', '시크릿 보관함이 잠겨 있습니다. 잠금을 해제하면 이 세션에서 쓸 수 있습니다.'],
  'not-eligible': ['이 세션은 사용할 수 없음', '이 세션에는 시크릿을 연결할 수 없습니다.'],
  'session-closed': ['종료된 세션', '세션이 종료되어 더 이상 시크릿을 연결할 수 없습니다.'],
  'source-unavailable': ['원본 컴퓨터 연결 실패', '원본 컴퓨터에 연결하지 못했습니다. 그 컴퓨터의 연결과 잠금 상태를 확인하세요.'],
  'worker-update-pending': ['새 실행 워커 적용 대기', '새 실행 워커 적용 대기 중입니다. 진행 중인 작업이 끝나면 다시 시도하세요.'],
};

/** Why the session's secrets cannot be shown or used as usual; each state reads differently. */
export function SecretSessionState({ error }: { error?: SecretSessionError }) {
  const { t } = useI18n();
  if (!error) return null;
  const [title, detail] = stateLabels[error];
  return <p role="alert" className={`secret-state secret-state-${error}`}><strong>{t(title)}</strong><span>{t(detail)}</span></p>;
}

/**
 * The chat's second tab: every secret this session may use and why, the owner's own connections, and saved secrets
 * to connect. Listing never connects anything; only the buttons here change the session.
 */
export function SecretAvailable({ view, busy, change, onPaste, onSharing }: {
  view: SecretSessionView; busy: boolean; change: SecretChange; onPaste: () => void; onSharing: (secretId: string) => void;
}) {
  const { t } = useI18n(); const [picking, setPicking] = useState(false); const [query, setQuery] = useState('');
  const used = new Map(usedSecrets(view.usage).map(use => [use.secretId, use]));
  // Only what this session cannot use now, including a secret disconnected here, is offered for connecting.
  const available = new Set(view.available.map(secret => secret.id));
  const unconnected = view.connectable.filter(secret => !available.has(secret.id));
  const candidates = unconnected.filter(secret => secretMatches(secret, query));
  // During a worker handoff the vault can still be unlocked here.
  const vaultClosed = view.error === 'locked' || view.error === 'uninitialized' || (view.error === 'worker-update-pending' && view.status.initialized && view.status.locked);
  const disconnected = view.disconnected ?? [];
  return <div className="secret-available">
    <SecretSessionState error={view.error} />
    {vaultClosed && (view.status.initialized || view.error !== 'worker-update-pending') && <SecretAccess status={view.status} busy={busy} change={change} />}
    {!!view.unavailableSources.length && view.error !== 'source-unavailable' && <p role="status" className="secret-source-notice">{t('원본 컴퓨터 {0}곳에 연결하지 못해 그곳의 시크릿은 빠져 있습니다.', { 0: view.unavailableSources.length })}</p>}
    {/* Answering sources on an older build: not a connection failure, and they appear once they update. */}
    {!!view.updatePendingSources.length && <p role="status" className="secret-source-notice">{t('원본 컴퓨터 {0}곳이 업데이트를 기다리고 있어 그 시크릿은 아직 표시하지 않습니다.', { 0: view.updatePendingSources.length })}</p>}
    {/* During a worker handoff only the vault's status is known; nothing here can change yet. */}
    {!vaultClosed && view.error !== 'worker-update-pending' && <>
      <div className="secret-actions secret-available-actions">
        <button type="button" aria-expanded={picking} disabled={busy} onClick={() => setPicking(value => !value)}><Link2 size={14} aria-hidden="true" />{t('기존 시크릿 연결')}</button>
        <button type="button" disabled={busy} onClick={onPaste}><Plus size={14} aria-hidden="true" />{t('새 시크릿 추가')}</button>
      </div>
      {picking && <section className="secret-connect" aria-label={t('기존 시크릿 연결')}>
        <label className="secret-search"><Search size={15} aria-hidden="true" /><input type="search" autoFocus aria-label={t('저장된 시크릿 검색')} placeholder={t('이름이나 환경 변수 검색')} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <p className="secret-hint">{t('공유하지 않은 시크릿도 이 세션에만 연결할 수 있습니다. 공유 범위는 바뀌지 않습니다.')}</p>
        {candidates.length ? <ul>{candidates.map(secret => <li key={secret.id} className="secret-row"><span><strong>{secret.name}</strong><small>{t(kindLabels[secret.kind])}{secret.fields?.length ? ` · ${secret.fields.join(', ')}` : ''}</small></span>
          <button type="button" disabled={busy} aria-label={t('{0} 이 세션에 연결', { 0: secret.name })} onClick={() => void change('session-connect', { secretIds: [secret.id] })}>{t('연결하기')}</button>
        </li>)}</ul> : <p className="secret-empty">{t(!view.connectable.length ? '저장한 시크릿이 없습니다.' : !unconnected.length ? '저장한 시크릿을 모두 이 세션에서 쓸 수 있습니다.' : '검색 결과가 없습니다.')}</p>}
      </section>}
      {view.available.length ? <ul className="secret-list">{view.available.map(secret => {
        const use = used.get(secret.id); const remote = secret.basis.includes('remote');
        // Only saved secrets of this vault have sharing; a value pasted for this session alone does not.
        const saved = !remote && view.connectable.some(entry => entry.id === secret.id);
        return <li key={secret.id} className="secret-item">
          <div className="secret-item-name"><strong><KeyRound size={12} aria-hidden="true" />{secret.name}</strong><small>{t(kindLabels[secret.kind])}{secret.fields?.length ? ` · ${secret.fields.join(', ')}` : ''}</small></div>
          <div className="secret-sharing">{secret.basis.map(basis => <span key={basis} className={`secret-chip secret-basis-${basis}`} title={remote && basis === 'remote' ? secret.sourceHostId : undefined}>{t(basisLabels[basis])}</span>)}</div>
          <small className="secret-use">{use ? t(use.outcome === 'blocked' ? '최근 사용 차단 · {0}' : '최근 사용 · {0}', { 0: relativeTime(new Date(use.at).toISOString()) }) : t('아직 사용하지 않음')}</small>
          <div className="secret-item-actions">
            {saved && <button type="button" disabled={busy} aria-label={t('{0} 공유 설정', { 0: secret.name })} onClick={() => onSharing(secret.id)}><Settings2 size={14} aria-hidden="true" />{t('공유 설정')}</button>}
            <button type="button" disabled={busy} aria-label={t('{0} 이 세션에서 끊기', { 0: secret.name })} onClick={() => void change('session-disconnect', { secretIds: [secret.id] })}><Unlink size={14} aria-hidden="true" />{t('이 세션에서 끊기')}</button>
          </div>
        </li>;
      })}</ul> : <p className="secret-empty">{t('이 세션에서 사용할 수 있는 시크릿이 없습니다. 붙여넣거나 저장한 시크릿을 연결하세요.')}</p>}
      {/* A value kept with this session comes back by connecting it; another source's key by lifting this session's stop, its source deciding the rest. */}
      {!!disconnected.length && <section className="secret-disconnected" aria-label={t('이 세션에서 끊은 시크릿')}>
        <h4>{t('이 세션에서 끊은 시크릿')}</h4>
        <ul className="secret-list">{disconnected.map(secret => {
          const remote = secret.remote;
          return <li key={secret.id} className="secret-row"><span><strong>{secret.name}</strong><small>{t(kindLabels[secret.kind])}{remote ? ` · ${t('원격 원본')}` : ` · ${t('이 세션에만')}`}</small></span>
            <button type="button" disabled={busy} aria-label={t('{0} 다시 허용', { 0: secret.name })} onClick={() => void change(remote ? 'session-reallow' : 'session-connect', { secretIds: [secret.id] })}><RotateCcw size={14} aria-hidden="true" />{t('다시 허용')}</button>
          </li>;
        })}</ul>
      </section>}
    </>}
  </div>;
}
