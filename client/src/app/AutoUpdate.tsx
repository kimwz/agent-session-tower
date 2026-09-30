import { useEffect, useState } from 'react';
import { Check, Clock, Copy, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { AutoUpdateStatus, ToolUpdate, ToolUpdateReason } from '../../../shared/link';
import type { Provider, Snapshot } from '../../../shared/types';
import { absoluteTime, api, copyText, outdatedRunner, providerLabels } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { useI18n } from '../i18n/i18n';

const newer = (a?: string, b?: string) => {
  const [x, y] = [a, b].map(value => value && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : undefined);
  if (!x || !y) return false;
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
};

/** Why a CLI was not brought up to date, in words; the details stay in logs/tool-update.log on that computer. */
function useReasons(): Record<ToolUpdateReason, string> {
  const { t } = useI18n();
  return {
    'not-updated': t('업데이트 명령이 끝났지만 버전이 바뀌지 않았습니다.'),
    'command-failed': t('업데이트 명령이 실패했습니다.'),
    stuck: t('설치가 1시간 넘게 끝나지 않고 있습니다.'),
    'install-method': t('Tower가 업데이트할 수 없는 방식으로 설치되어 있습니다. 설치한 방식으로 직접 업데이트하세요.'),
    'not-root-only': t('root가 아닌 계정도 바꿀 수 있는 위치에 설치되어 있어, root로 실행하는 Tower는 업데이트하지 않습니다.'),
    'no-npm': t('npm을 찾지 못했습니다.'),
    'unreadable-version': t('설치된 버전을 확인하지 못했습니다.'),
  };
}

/** One CLI's version and what its automatic update is doing, as a short label and an explanation. */
export function useToolLabel() {
  const { t } = useI18n();
  const reasons = useReasons();
  return (tool: ToolUpdate | undefined): { text: string; title: string; tone: 'ok' | 'busy' | 'wait' | 'warn' } | undefined => {
    if (!tool) return undefined;
    const version = tool.version ? `v${tool.version}` : '';
    const next = tool.nextAt ? t('{0}에 다시 시도합니다.', { 0: absoluteTime(tool.nextAt) }) : '';
    const reason = tool.reason ? reasons[tool.reason] : '';
    switch (tool.state) {
      case 'current': return { text: version, title: tool.updatedAt ? t('최신 버전입니다. {0}에 자동으로 업데이트했습니다.', { 0: absoluteTime(tool.updatedAt) }) : t('최신 버전입니다.'), tone: 'ok' };
      case 'updating': return { text: t('{0} → v{1} 업데이트 중', { 0: version, 1: tool.target ?? '' }), title: tool.reason === 'stuck' ? reasons.stuck : t('새 작업은 업데이트가 끝나면 시작됩니다.'), tone: 'busy' };
      case 'waiting': return { text: t('{0} → v{1} 대기', { 0: version, 1: tool.target ?? '' }), title: t('이 에이전트가 하는 작업(Tower의 요청과 라우팅, 터미널에서 진행 중인 대화)이 모두 끝나면 업데이트합니다.'), tone: 'wait' };
      case 'failed': return { text: t('{0} · 업데이트 실패', { 0: version }), title: [t('v{0}(으)로 업데이트하지 못했습니다.', { 0: tool.target ?? '' }), reason, next].filter(Boolean).join(' '), tone: 'warn' };
      // Nothing is tried again while it does not start, so no retry time is shown; this computer's own page names the fix.
      case 'broken': return { text: t('실행 안 됨'), title: [t('업데이트 뒤 실행되지 않고, 이전 버전으로도 되돌리지 못했습니다. 직접 다시 설치하세요(기록: logs/tool-update.log).'), tool.fix ? t('다시 설치하는 명령: {0}', { 0: tool.fix }) : ''].filter(Boolean).join(' '), tone: 'warn' };
      // As root, a CLI others could change is not even asked its version.
      case 'unsupported': return { text: version ? t('{0} · 자동 업데이트 안 됨', { 0: version }) : t('자동 업데이트 안 됨'), title: [tool.target ? t('v{0}이(가) 나왔습니다.', { 0: tool.target }) : '', reason].filter(Boolean).join(' '), tone: 'warn' };
    }
  };
}

const icon = (tone: 'ok' | 'busy' | 'wait' | 'warn', size: number) => tone === 'busy' ? <LoaderCircle size={size} className="spin" aria-hidden="true" />
  : tone === 'wait' ? <Clock size={size} aria-hidden="true" /> : tone === 'warn' ? <TriangleAlert size={size} aria-hidden="true" /> : null;

/** Beside a CLI in the sidebar: its version, or what its update is doing. A broken one copies the command that fixes it. */
export function ToolVersion({ tool }: { tool?: ToolUpdate }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const label = useToolLabel()(tool);
  if (!label || !label.text) return null;
  if (tool?.state === 'broken' && tool.fix) {
    const fix = tool.fix;
    return <button type="button" className={`tool-version ${label.tone}`} title={`${label.title} ${t('눌러서 명령 복사')}`}
      onClick={() => { void copyText(fix).then(ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }); }}>
      {copied ? <Check size={9} aria-hidden="true" /> : icon(label.tone, 9)}{copied ? t('명령 복사됨') : label.text}</button>;
  }
  return <small className={`tool-version ${label.tone}`} title={label.title}>{icon(label.tone, 9)}{label.text}</small>;
}

/** A joined computer's CLIs, from its report. */
export function NodeTools({ autoUpdate }: { autoUpdate?: AutoUpdateStatus }) {
  const label = useToolLabel();
  const tools = (['claude', 'codex'] as Provider[]).map(provider => ({ provider, label: label(autoUpdate?.tools[provider]) })).filter(item => item.label?.text);
  if (!tools.length) return null;
  return <p className="remote-tools">{tools.map(({ provider, label: shown }) => <span key={provider} className={`tool-version ${shown!.tone}`} title={shown!.title}>
    {icon(shown!.tone, 10)}{providerLabels[provider]} {shown!.text}</span>)}</p>;
}

/**
 * In the header, only when there is something to know: a newer Tower this one cannot install by itself (with the command
 * that makes it keep itself current), or an update that failed and is tried again later.
 */
export function TowerUpdateBadge({ snapshot }: { snapshot: Pick<Snapshot, 'version' | 'autoUpdate'> | null | undefined }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const tower = snapshot?.autoUpdate?.tower;
  if (!snapshot || !tower?.latest || !newer(tower.latest, snapshot.version)) return null;
  if (tower.kind === 'unmanaged' && tower.serviceCommand) {
    const title = t('Tower v{0}이(가) 나왔습니다. 이 Tower는 직접 실행한 것이라 스스로 업데이트하지 않습니다. 이 명령으로 백그라운드 서비스로 설치하면 Tower, Claude Code, Codex가 항상 최신으로 유지됩니다. 실행 중인 작업과 터미널은 계속됩니다: {1}', { 0: tower.latest, 1: tower.serviceCommand });
    return <button type="button" className="runner-outdated tower-update" title={title} aria-label={title}
      onClick={() => { void copyText(tower.serviceCommand!).then(ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }); }}>
      {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t('명령 복사됨') : t('Tower v{0} 설치 명령', { 0: tower.latest })}</button>;
  }
  if (tower.kind === 'service' && tower.nextAt) {
    return <span className="runner-outdated" role="status" title={t('v{0}(으)로 업데이트하지 못해 이 버전으로 계속 실행 중입니다. {1}에 자동으로 다시 시도합니다(기록: logs/update.log).', { 0: tower.latest, 1: absoluteTime(tower.nextAt) })}>
      <TriangleAlert size={12} />{t('Tower 업데이트 재시도 대기')}</span>;
  }
  return null;
}

/**
 * The execution worker still on an older build. When it can switch on request, "update now" asks running turns to
 * wrap up, stops those still running after ten minutes, and resumes them on the new version; meanwhile the badge
 * counts down.
 */
export function RunnerUpdateBadge({ snapshot, token }: { snapshot: Pick<Snapshot, 'version' | 'runnerVersion' | 'runnerUpdate' | 'runnerForceUpdate' | 'updateDrain' | 'runs'> | null | undefined; token: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const drain = snapshot?.updateDrain;
  useEffect(() => {
    if (!drain) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [drain]);
  if (drain) {
    const left = Math.max(0, Math.ceil((Date.parse(drain.deadline) - now) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    return <span className="runner-outdated" role="status" title={t('진행 중인 턴에 마무리를 요청했고 새 작업은 대기합니다. 마감까지 끝나지 않은 턴은 중지한 뒤 새 버전에서 이어서 진행합니다.')}>
      <LoaderCircle size={12} className="spin" aria-hidden="true" />{drain.running ? t('업데이트 중 · 턴 {0}개 마무리 대기 · {1}', { 0: drain.running, 1: clock }) : t('새 버전으로 전환 중')}</span>;
  }
  const outdated = outdatedRunner(snapshot);
  if (!snapshot || !outdated) return null;
  const title = snapshot.runnerUpdate === 'automatic'
    ? t('요청은 이전 버전({0}) 실행 워커에서 처리되어 최근 기능이 적용되지 않습니다. 진행 중인 작업이 모두 끝나는 순간 새 버전으로 자동 교체됩니다.', { 0: outdated })
    : t('요청은 이전 버전({0}) 실행 워커에서 처리되어 최근 기능이 적용되지 않습니다. 진행 중인 작업과 터미널이 없고 Slack 감시를 끈 상태에서 Tower를 종료하고 30초 뒤 다시 시작하면 교체됩니다.', { 0: outdated === 'legacy' ? t('이전') : outdated });
  const updateNow = async () => {
    const running = snapshot.runs.filter(run => run.status === 'running' && !run.steering).length;
    if (!window.confirm(t('진행 중인 턴 {0}개에 마무리를 요청하고 새 작업은 대기시킵니다. 최대 10분 뒤 남은 턴을 중지하고 새 버전으로 전환한 다음, 중단된 대화를 이어서 진행합니다. 지금 업데이트할까요?', { 0: running }))) return;
    setSending(true);
    try { await api('/api/runner/force-update', { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' }); }
    catch (error) { window.alert(error instanceof Error ? error.message : t('업데이트를 시작하지 못했습니다.')); }
    finally { setSending(false); }
  };
  return <>
    <span className="runner-outdated" role="status" title={title}><TriangleAlert size={12} />{t('실행 워커 업데이트 대기')}</span>
    {snapshot.runnerForceUpdate && <button type="button" className="runner-outdated tower-update" disabled={sending || !token} onClick={() => { void updateNow(); }}
      title={t('진행 중인 턴에 마무리를 요청하고 최대 10분 뒤 새 버전으로 전환합니다.')}>{sending ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : null}{t('지금 업데이트')}</button>}
  </>;
}
