import { useContext, useState, type FormEvent } from 'react';
import { FolderPlus, LoaderCircle, Terminal } from 'lucide-react';
import type { LoginState, NodeSummary } from '../../../shared/link';
import type { ManagedSection } from '../../../shared/managed';
import { api, relativeTime } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { SettingsFrameContext } from '../settings/SettingsPane';
import { useOpenWorkspace } from '../workspace/WorkspaceOverlay';
import { followState, loginStates, needsSignIn, secretState, syncView, type LoginTool } from './node-readiness';
import { scopedId } from './scope';

const post = <T,>(token: string, path: string, body: unknown) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify(body) });

/**
 * A joined computer as a place for new work: "호스트 설정 따르기" and how far this Tower's settings reached it, whether
 * Claude Code, Codex and gh are signed in there (with a terminal there to sign in), and a new folder cloned from a
 * repository.
 */
export function NodeReadiness({ token, node, busy, run }: { token: string; node: NodeSummary; busy: boolean; run: (work: () => Promise<unknown>) => Promise<boolean> }) {
  const { t } = useI18n();
  const name = node.label || node.name;
  const follow = followState(node);
  const sync = syncView(node);
  const logins = loginStates(node);
  const secrets = secretState(node);
  const setFollow = (value: boolean) => void run(() => post(token, `/api/link/nodes/${node.id}/follow`, { follow: value }));
  const notes: Record<typeof follow, string> = {
    off: t('이 Tower의 스킬·지침·모델·권한 규칙·빠른 판단 설정을 그 컴퓨터에 적용하지 않습니다.'),
    following: t('이 Tower의 스킬·지침·모델·권한 규칙·빠른 판단 설정을 그 컴퓨터에 그대로 적용합니다. 그 컴퓨터에서 바꾼 값은 다음 동기화 때 이 Tower의 값으로 돌아갑니다.'),
    offline: t('다시 연결되면 이 Tower의 설정을 따릅니다.'),
    unsupported: t('그 컴퓨터의 Tower를 업데이트하면 이 Tower의 설정을 따를 수 있습니다.'),
    elsewhere: t('그 컴퓨터는 다른 Tower의 설정을 따르고 있습니다.'),
  };
  const sections: Record<ManagedSection, string> = { skills: t('스킬'), models: t('모델'), permissions: t('권한'), decisions: t('빠른 판단') };
  const tools: Record<LoginTool, string> = { claude: 'Claude Code', codex: 'Codex', gh: 'gh' };
  const states: Record<LoginState, string> = { ok: t('로그인됨'), missing: t('로그인 필요'), unknown: t('확인 안 됨') };
  return <div className="remote-readiness">
    <label className="remote-switch"><input type="checkbox" checked={node.followHost === true} disabled={busy} onChange={event => setFollow(event.target.checked)} /><span>{t('호스트 설정 따르기')}</span></label>
    <p className="remote-readiness-note">{notes[follow]}{follow === 'elsewhere' && <> <button type="button" className="secondary-button" disabled={busy} onClick={() => setFollow(true)}>{t('이 Tower를 따르게 하기')}</button></>}</p>
    {sync && <div className={`remote-sync ${sync.state}`} role="status">
      {sync.state === 'synced' ? <p>{t('동기화됨 · {0} · {1}', { 0: sync.revision!, 1: relativeTime(sync.appliedAt!) })}</p>
        : sync.state === 'waiting' ? <p>{sync.workerPending ? t('그 컴퓨터의 실행 워커가 새 버전으로 바뀌면 동기화합니다.') : t('첫 동기화를 기다리는 중입니다.')}</p>
        : <><p><strong>{t('동기화 지연')}</strong> · {sync.revision ? t('그 컴퓨터는 마지막으로 적용한 설정({0}, {1})을 그대로 씁니다.', { 0: sync.revision, 1: relativeTime(sync.appliedAt!) }) : t('그 컴퓨터는 아직 이 Tower의 설정을 받지 못했습니다.')}</p>
          {sync.error && <p>{translateMessage(sync.error)}</p>}
          {sync.sections.length > 0 && <ul>{sync.sections.map(([section, message]) => <li key={section}><strong>{sections[section] ?? section}</strong>: {translateMessage(message)}</li>)}</ul>}</>}
    </div>}
    {logins && <ul className="remote-logins" aria-label={t('로그인 상태')}>{logins.map(([tool, state]) => <li key={tool} className={state}><span>{tools[tool]}</span><small>{states[state]}</small></li>)}</ul>}
    {secrets && <p className={`remote-secrets ${secrets.state}`} role="status"><strong>{t('시크릿')}</strong> · {{
      connected: t('연결됨 · 사용 가능 {0}개', { 0: String(secrets.available ?? 0) }),
      'trust-pending': t('신뢰 준비 중입니다. 두 컴퓨터의 보관함이 열리면 저절로 연결됩니다.'),
      'host-locked': t('이 Tower의 보관함이 잠겨 있어 그 컴퓨터가 시크릿을 쓸 수 없습니다.'),
      'needs-open': t('그 컴퓨터의 보관함을 한 번 열어 주세요(그 컴퓨터의 Tower › 설정 › 시크릿). 그 뒤로는 저절로 열립니다.'),
      offline: t('연결 끊김'),
      untrusted: t('이 컴퓨터의 시크릿 신뢰를 해제했습니다. 설정 › 시크릿에서 다시 신뢰할 수 있습니다.'),
    }[secrets.state]}</p>}
    {needsSignIn(node) && <SignInTerminal token={token} node={node} name={name} />}
    {follow === 'following' && node.status === 'connected' && <CloneForm token={token} node={node} />}
  </div>;
}

/** Opens a terminal in that computer's Workspace folder, to sign in there; the settings close to make room for it. */
function SignInTerminal({ token, node, name }: { token: string; node: NodeSummary; name: string }) {
  const { t } = useI18n();
  const open = useOpenWorkspace();
  const frame = useContext(SettingsFrameContext);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setOpening(true); setError('');
    try {
      const { cwd } = await post<{ cwd: string }>(token, `/api/link/nodes/${node.id}/workspace`, {});
      frame.close();
      open?.(scopedId(node.id, cwd), 'terminal', name);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setOpening(false); }
  };
  return <div className="remote-signin">
    <p>{t('그 컴퓨터의 터미널에서 claude, codex login, gh auth login으로 로그인하세요.')}</p>
    <button type="button" className="secondary-button" disabled={opening || !open} onClick={() => void start()}>{opening ? <LoaderCircle size={13} className="spin" /> : <Terminal size={13} />}{t('터미널 열기')}</button>
    {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
  </div>;
}

/** "저장소에서 새 폴더": that computer clones the repository into a new folder, which then shows on the canvas. */
function CloneForm({ token, node }: { token: string; node: NodeSummary }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setCloning(true); setError(''); setMade('');
    try { const { cwd } = await post<{ cwd: string }>(token, `/api/link/nodes/${node.id}/clone`, { url: url.trim() }); setMade(cwd); setUrl(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCloning(false); }
  };
  return <form className="remote-join remote-clone" onSubmit={event => void submit(event)}>
    <label>{t('저장소에서 새 폴더')}<input value={url} placeholder="https://github.com/owner/repo" onChange={event => setUrl(event.target.value)} spellCheck={false} autoComplete="off" disabled={cloning} /></label>
    <button className="secondary-button" disabled={cloning || !url.trim()}>{cloning ? <LoaderCircle size={13} className="spin" /> : <FolderPlus size={13} />}{cloning ? t('받는 중…') : t('만들기')}</button>
    {made && <p role="status" className="trigger-note">{t('{0}에 만들었습니다. 캔버스의 그 폴더에서 새 세션을 시작하세요.', { 0: made })}</p>}
    {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
  </form>;
}
