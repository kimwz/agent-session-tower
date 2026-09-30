import { translate as t, useI18n } from '../i18n/i18n';
import { memo, useId } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Check, Clock, GitBranch, Monitor, Radio, Sparkles } from 'lucide-react';
import type { ProviderHealth, Session, SystemStatus } from '../../../shared/types';
import type { NodeStatus } from '../../../shared/link';
import { localPart } from '../remote/scope';
import { SessionContextIcon } from '../sessions/SessionContextIcon';
import { TowerVersionsBadge, type TowerVersions } from './TowerVersions';
import { outcomeLabels } from '../sessions/SessionOutcomeBadge';
import { cleanPreview, providerLabels, relativeTime, sessionActivityAt, sessionState, sessionTitle } from '../common/lib';
import { ProjectGroupHeader, type ProjectGroupHeaderData } from '../project-groups/ProjectGroupHeader';
import { ProviderUsage } from '../providers/ProviderUsage';
import { SystemRings } from './SystemRings';

export type AgentData = { session: Session; selected: boolean; unread: boolean; onSelect: (id: string) => void;
  /** Its computer is out of reach: the card shows the last state seen. */
  stale?: boolean };
export type ProjectData = ProjectGroupHeaderData & { onAutoPrompt: (cwd?: string) => void; stale?: boolean };
/** How a joined computer is doing, shown on its host node. */
export type HostLink = { status: NodeStatus; live: boolean; version?: string;
  /** Some state of it arrived since this Tower started; without it there is nothing yet to show. */
  known?: boolean; canWork?: boolean; updating?: boolean };
export type HostData = { name: string; active: number; providers: ProviderHealth[]; disabled: boolean; onAutoPrompt: (cwd?: string) => void; link?: HostLink;
  /** This computer's Tower version; a joined computer's is in `link`. */
  version?: string;
  /** Every Tower process's version, shown on hover. */
  versions?: TowerVersions;
  /** CPU, memory and disk, while the computer's state is arriving. */
  system?: SystemStatus };

function linkLabel(link: HostLink): string {
  if (link.updating) return link.status === 'connected' ? t("업데이트 중") : t("새 버전으로 다시 시작하는 중");
  if (link.status === 'update-required') return t("업데이트 필요");
  if (link.status === 'removed-by-node') return t("상대 컴퓨터가 연결을 끊음");
  if (link.status === 'connected') return !link.live ? t("불러오는 중") : link.canWork === false ? t("보기 전용") : t("연결됨");
  return t("오프라인");
}

export const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<AgentData>>) {
  useI18n();
  const contextDescriptionId = useId();
  const session = data.session;
  const activityAt = sessionActivityAt(session);
  const state = sessionState(session);
  const outcome = session.status !== 'working' ? session.outcome : undefined;
  return <>
    <button className={`agent-card ${session.provider} ${session.status} ${data.selected ? 'selected' : ''} ${data.unread ? 'has-unread' : ''}${data.stale ? ' is-stale' : ''}`} onClick={() => data.onSelect(session.id)} aria-describedby={contextDescriptionId} aria-label={`${t("{0}: {1}, {2}{3}. 대화 열기", { 0: providerLabels[session.provider], 1: sessionTitle(session), 2: outcome ? `${state.label}, ${outcomeLabels[outcome]}` : state.label, 3: data.unread ? t(", 새 활동") : t(", 확인함") })}${data.stale ? ` ${t("(마지막으로 본 상태)")}` : ''}`}>
      {session.status === 'working' && !data.stale && <span className="agent-activity-border" aria-hidden="true" />}
      {data.unread && <i className="unread-dot" title={t("새 활동")} aria-hidden="true" />}
      {outcome && <span className="agent-card-flags"><span className={`agent-outcome ${outcome}`}><i />{outcomeLabels[outcome]}</span></span>}
      <div className="agent-card-top"><SessionContextIcon provider={session.provider} usage={session.contextUsage} descriptionId={contextDescriptionId} />{session.isSubagent && <span className="subagent-mark" title={t("하위 에이전트")}><GitBranch size={12} /></span>}</div>
      <div className="agent-card-title" title={sessionTitle(session)}>{sessionTitle(session)}</div>
      <div className="agent-card-bottom"><span className="agent-provider">{providerLabels[session.provider]}</span><span className={`agent-state ${state.key}`}>{state.key === 'scheduled' ? <Clock size={11} /> : state.key === 'completed' ? <Check size={11} /> : state.key === 'working' ? <Radio size={11} /> : <i />}{state.label}</span></div>
      <p className="agent-card-preview">{cleanPreview(session.lastMessage) || t("대화 기록을 확인하세요")}</p><time className="agent-updated" dateTime={activityAt}>{relativeTime(activityAt)}<ArrowUpRight size={11} /></time>
    </button>
  </>;
});

export const ProjectGroupNode = memo(function ProjectGroupNode({ data }: NodeProps<Node<ProjectData>>) {
  useI18n();
  return <div className={`manual-project-lane ${data.hidden ? 'is-hidden' : ''}${data.stale ? ' is-stale' : ''}`}><div className="project-drag-handle"><Handle type="target" position={Position.Top} /><ProjectGroupHeader data={data} /></div><button type="button" className="auto-prompt-trigger nodrag nopan" aria-label={t("{0} 폴더에서 Auto Prompt 열기", { 0: data.name })} title="Auto Prompt" disabled={data.disabled || !localPart(data.path).startsWith('/')} onClick={() => data.onAutoPrompt(data.path)}><Sparkles size={32} aria-hidden="true" /></button>{!data.count && <p className="project-group-empty">{t("표시된 세션이 없습니다")}<span>{t("폴더 설정 메뉴에서 새 세션을 시작하세요")}</span></p>}</div>;
});
export const HostNode = memo(function HostNode({ data }: NodeProps<Node<HostData>>) {
  useI18n();
  const link = data.link;
  const offline = link && !(link.status === 'connected' && link.live);
  return <div className={`host-with-usage${link ? ' is-remote' : ''}${offline ? ' is-stale' : ''}`}><div className="host-node has-auto-prompt"><span className="host-icon"><Monitor size={20} /></span><div className="host-copy"><strong title={data.name}>{data.name || t("이 Mac")}</strong>
    {link && <span className={`host-link ${link.status}${link.live ? ' live' : ''}${link.updating ? ' updating' : ''}`} role="status"><i />{linkLabel(link)}{link.version && link.live && !data.versions ? ` · v${link.version}` : ''}
      {link.version && link.live && data.versions && <> · <TowerVersionsBadge versions={data.versions} /></>}</span>}
    {!link && data.version && <span className="host-link local"><i />{t("이 컴퓨터")} · {data.versions ? <TowerVersionsBadge versions={data.versions} /> : `v${data.version}`}</span>}
    {data.system && !offline && <SystemRings status={data.system} />}
    <span><i className={data.active && !offline ? 'live-pip' : ''} /><span>{offline ? link?.known === false ? t("아직 상태를 받지 못했습니다") : t("마지막으로 본 상태입니다") : data.active ? t("{0}개 에이전트 작업 중", { 0: data.active }) : t("다음 작업을 기다리는 중")}</span></span></div><button type="button" className="auto-prompt-trigger nodrag nopan" aria-label={link ? t("{0}에서 Auto Prompt 열기", { 0: data.name }) : t("이 기기에서 Auto Prompt 열기")} title="Auto Prompt" disabled={data.disabled} onClick={() => data.onAutoPrompt()}><Sparkles size={32} aria-hidden="true" /></button></div><ProviderUsage providers={data.providers} /><Handle type="source" position={Position.Bottom} /></div>;
});
export const nodeTypes = { agent: AgentNode, projectGroup: ProjectGroupNode, host: HostNode };
