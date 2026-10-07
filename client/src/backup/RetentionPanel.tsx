import { useCallback, useContext, useEffect, useState } from 'react';
import type { RetentionOverview } from '../../../shared/retention';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';
import { SettingsFrameContext } from '../settings/SettingsPane';

/** Policy status is separate from the encrypted settings backup, which omits native history. */
export function RetentionPanel({ token }: { token: string }) {
  const [overview, setOverview] = useState<RetentionOverview & { targets?: { id: string; title: string }[] }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [manifest, setManifest] = useState('');
  const [files, setFiles] = useState<{ name: string; nativeId: string }[]>([]);
  const [inspectedBundle, setInspectedBundle] = useState('');
  const [content, setContent] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [cwd, setCwd] = useState('');
  const [path, setPath] = useState('');
  const { active } = useContext(SettingsFrameContext);
  const load = useCallback(async () => { setOverview(await api<RetentionOverview>('/api/retention')); }, []);
  useEffect(() => { if (active) void load().catch(error => setError(String(error))); }, [active, load]);
  async function act(action: string, id?: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api(`/api/retention/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token },
        body: JSON.stringify({ ...(id ? { id } : {}), ...(['export', 'import'].includes(action) ? { cwd, path } : {}) }) });
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function inspect(id: string) {
    setError('');
    try {
      const value = await api<{ files: { name: string; nativeId: string }[] }>(`/api/retention/bundles/${encodeURIComponent(id)}`);
      setManifest(JSON.stringify(value, null, 2)); setFiles(value.files); setInspectedBundle(id); setContent('');
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  const blocked = !overview || Object.values(overview.providers).some(provider => provider.status === 'blocked');
  return <section className="retention-policy" aria-label="세션 보관 정책">
    <h3>세션 보관 정책</h3>
    <p className="auth-hint">프로젝트별 부모 최근 20개 · 하위는 마지막 작업 종료 후 7일. 실행·대기 작업은 보호하며 기존 기록에는 도입 후 7일 유예를 적용합니다.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {overview && <>
      {blocked && <p className="auth-hint" role="status">Claude·Codex의 안전한 원본 이전 계약이 확인되지 않아 자동 제거는 보류 중입니다. 원본·목록·스캔은 유지되며 현재 물리 절감은 0입니다.</p>}
      <p>후보 {overview.candidates} · 보호/유예 {overview.deferred} · 이전 완료 {overview.archived} · 제공자 보류 {overview.blockedProvider} · 백업만 {overview.backupOnly} · 실패 {overview.failures}</p>
      <p>별도 백업 {(overview.coldBytes / 1024 ** 2).toFixed(1)} MiB · 도입 {overview.migratedAt} · 마지막 확인 {overview.lastCheckedAt || '아직 없음'}</p>
      {overview.verification && <p role="status">백업 검증: {overview.verification === 'complete' ? '완료' : overview.verification === 'running' ? '검증 중 · 원본 제거와 복원은 대기합니다.' : '대기 중 · 원본 제거와 복원은 대기합니다.'}</p>}
      <button type="button" disabled={busy} onClick={() => void act('check')}>현재 기록 확인</button>
      <p className="auth-hint">기존 닫기는 숨김만 수행합니다. 명시적 보관 요청도 제공자 보호 조건을 통과해야 이전됩니다. 백업만 만들면 원본과 디스크 사용량은 줄지 않습니다.</p>
      <label>하위 세션<select value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">세션 선택</option>{overview.targets?.map(target => <option key={target.id} value={target.id}>{target.title} ({target.id})</option>)}</select></label>
      <button type="button" disabled={busy || !sessionId} onClick={() => void act('archive', sessionId)}>명시적 보관 요청</button>
      <button type="button" disabled={busy || !sessionId} onClick={() => void act('backup', sessionId)}>적격 대상 백업만 생성</button>
      <ul>{overview.entries.map(entry => <li key={entry.id}>{entry.candidate.rootId} · {entry.phase}{entry.error ? ` · ${entry.error}` : ''}
        {['backup-verified', 'archived', 'restored-awaiting-start'].includes(entry.phase) && <>
          <button type="button" onClick={() => void inspect(entry.id)}>백업 정보 열람</button>
          <button type="button" disabled={busy || blocked || entry.phase !== 'archived'} onClick={() => void act('restore', entry.id)}>원본 복원</button>
        </>}
      </li>)}</ul>
      {manifest && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{manifest}</pre>}
      {files.map(file => <button key={file.name} type="button" onClick={() => {
        void api<{ text: string; truncated: boolean }>(`/api/retention/bundles/${encodeURIComponent(inspectedBundle)}/files/${file.name}`)
          .then(value => setContent(value.text + (value.truncated ? '\n… 미리보기 한도를 넘어 일부만 표시합니다.' : '')))
          .catch(error => setError(error instanceof Error ? error.message : String(error)));
      }}>원문 열람 ({file.nativeId})</button>)}
      {content && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</pre>}
      <p className="auth-hint">별도 세션 백업은 위 설정 백업에 포함되지 않습니다. 내보내기·가져오기는 Tower에 등록된 작업 폴더 안의 별도 번들 디렉터리를 사용합니다.</p>
      <label>번들 ID<input value={bundleId} onChange={event => setBundleId(event.target.value)} /></label>
      <label>작업 폴더<input value={cwd} onChange={event => setCwd(event.target.value)} /></label>
      <label>폴더 내 상대 경로<input value={path} onChange={event => setPath(event.target.value)} /></label>
      <button type="button" disabled={busy || !bundleId || !cwd || !path} onClick={() => void act('export', bundleId)}>별도 백업 내보내기</button>
      <button type="button" disabled={busy || !cwd || !path} onClick={() => void act('import', bundleId || 'import')}>별도 백업 가져오기</button>
    </>}
  </section>;
}
