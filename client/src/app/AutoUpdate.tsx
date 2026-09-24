import { useState } from 'react';
import { Check, Copy, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { AutoUpdateStatus, ToolUpdate, ToolUpdateReason } from '../../../shared/link';
import type { Provider, Snapshot } from '../../../shared/types';
import { absoluteTime, copyText, providerLabels } from '../common/lib';
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
  return (tool: ToolUpdate | undefined): { text: string; title: string; tone: 'ok' | 'busy' | 'warn' } | undefined => {
    if (!tool) return undefined;
    const version = tool.version ? `v${tool.version}` : '';
    const next = tool.nextAt ? t('{0}에 다시 시도합니다.', { 0: absoluteTime(tool.nextAt) }) : '';
    const reason = tool.reason ? reasons[tool.reason] : '';
    switch (tool.state) {
      case 'current': return { text: version, title: tool.updatedAt ? t('최신 버전입니다. {0}에 자동으로 업데이트했습니다.', { 0: absoluteTime(tool.updatedAt) }) : t('최신 버전입니다.'), tone: 'ok' };
      case 'updating': return { text: t('{0} → v{1} 업데이트 중', { 0: version, 1: tool.target ?? '' }), title: tool.reason === 'stuck' ? reasons.stuck : t('새 작업은 업데이트가 끝나면 시작됩니다.'), tone: 'busy' };
      case 'waiting': return { text: t('{0} → v{1} 대기', { 0: version, 1: tool.target ?? '' }), title: t('Tower에서 이 에이전트의 작업이 모두 끝나면 업데이트합니다.'), tone: 'busy' };
      case 'failed': return { text: t('{0} · 업데이트 실패', { 0: version }), title: [t('v{0}(으)로 업데이트하지 못했습니다.', { 0: tool.target ?? '' }), reason, next].filter(Boolean).join(' '), tone: 'warn' };
      case 'broken': return { text: t('실행 안 됨'), title: [t('업데이트 뒤 실행되지 않고, 이전 버전으로도 되돌리지 못했습니다. 직접 다시 설치하세요(기록: logs/tool-update.log).'), next].filter(Boolean).join(' '), tone: 'warn' };
      case 'unsupported': return { text: t('{0} · 자동 업데이트 안 됨', { 0: version }), title: [t('v{0}이(가) 나왔습니다.', { 0: tool.target ?? '' }), reason].filter(Boolean).join(' '), tone: 'warn' };
    }
  };
}

/** Beside a CLI in the sidebar: its version, or what its update is doing. */
export function ToolVersion({ tool }: { tool?: ToolUpdate }) {
  const label = useToolLabel()(tool);
  if (!label || !label.text) return null;
  return <small className={`tool-version ${label.tone}`} title={label.title}>
    {label.tone === 'busy' ? <LoaderCircle size={9} className="spin" aria-hidden="true" /> : label.tone === 'warn' ? <TriangleAlert size={9} aria-hidden="true" /> : null}{label.text}</small>;
}

/** A joined computer's CLIs, from its report. */
export function NodeTools({ autoUpdate }: { autoUpdate?: AutoUpdateStatus }) {
  const label = useToolLabel();
  const tools = (['claude', 'codex'] as Provider[]).map(provider => ({ provider, label: label(autoUpdate?.tools[provider]) })).filter(item => item.label?.text);
  if (!tools.length) return null;
  return <p className="remote-tools">{tools.map(({ provider, label: shown }) => <span key={provider} className={`tool-version ${shown!.tone}`} title={shown!.title}>
    {shown!.tone === 'warn' && <TriangleAlert size={10} aria-hidden="true" />}{providerLabels[provider]} {shown!.text}</span>)}</p>;
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
