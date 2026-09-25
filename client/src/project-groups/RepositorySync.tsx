import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Bot, GitBranch, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { pullBlocker, pushBlocker, repositoryNeedsAgent, type PullBlocker, type PushBlocker, type RepositoryAction, type RepositoryStatus } from '../../../shared/repositories';
import { relativeTime } from '../common/lib';
import type { SessionDraft } from '../sessions/NewSessionDialog';

const pullReasons: Record<PullBlocker, string> = {
  detached: "브랜치가 체크아웃되어 있지 않습니다.",
  'no-upstream': "이 브랜치가 추적하는 원격 브랜치가 없습니다.",
  'up-to-date': "이미 최신 상태입니다.",
  diverged: "로컬에만 있는 커밋이 있어 fast-forward할 수 없습니다. 에이전트에게 병합이나 리베이스를 요청하세요.",
  changes: "커밋하지 않은 변경 사항이 있어 받지 않았습니다.",
  busy: "이 폴더에서 에이전트가 작업 중이라 받지 않았습니다.",
};
const pushReasons: Record<PushBlocker, string> = {
  detached: "브랜치가 체크아웃되어 있지 않습니다.",
  'no-upstream': "이 브랜치가 추적하는 원격 브랜치가 없습니다.",
  nothing: "푸시할 커밋이 없습니다.",
  behind: "원격에 새 커밋이 있어 푸시할 수 없습니다. 먼저 받은 뒤 푸시하세요.",
};

/** One line saying where the branch stands, for the badge title and the dialog. */
export function repositorySummary(status: RepositoryStatus): string {
  if (!status.branch) return t("브랜치가 체크아웃되어 있지 않습니다.");
  if (!status.upstream) return t("{0}: 추적하는 원격 브랜치 없음", { 0: status.branch });
  const parts = [
    status.behind ? t("{0}개 뒤처짐", { 0: status.behind }) : '',
    status.ahead ? t("푸시하지 않은 커밋 {0}개", { 0: status.ahead }) : '',
    status.changes ? t("커밋하지 않은 파일 {0}개", { 0: status.changes }) : '',
  ].filter(Boolean);
  return t("{0} ↔ {1}: {2}", { 0: status.branch, 1: status.upstream, 2: parts.length ? parts.join(', ') : t("최신 상태") });
}

/** Out of sync means commits to receive or to publish; uncommitted edits alone are normal work. */
export function repositoryOutOfSync(status: RepositoryStatus): boolean {
  return Boolean(status.upstream && (status.ahead || status.behind));
}

/** The request a new session starts with when the user hands the repository to an agent. */
export function repositoryAgentDraft(status: RepositoryStatus): SessionDraft {
  return {
    title: t("Git 정리: {0}", { 0: status.branch || '' }),
    prompt: [
      t("이 저장소를 원격 브랜치와 동기화해 주세요."),
      t("현재 상태: {0}", { 0: repositorySummary(status) }),
      '',
      t("1. git fetch 후 git status와 git diff로 커밋하지 않은 변경 사항과 로컬 커밋을 살펴보세요."),
      t("2. 완성된 변경은 의미 단위로 나눠 커밋하세요. 미완성이거나 임시 파일, 비밀 정보로 보이는 변경은 커밋하지 말고 알려 주세요."),
      t("3. 원격에 새 커밋이 있으면 받아서 합치세요. fast-forward가 안 되면 리베이스나 병합을 하고, 충돌을 판단하기 어려우면 멈추고 물어보세요."),
      t("4. 푸시할 커밋이 있으면 원격 브랜치에 푸시하세요. 강제 푸시, reset --hard, 변경 사항 폐기는 하지 마세요."),
      t("5. 끝나면 무엇을 커밋하고 받고 푸시했는지, 남은 문제가 있는지 알려 주세요."),
    ].join('\n'),
  };
}

function actionLabel(status: RepositoryStatus): string | undefined {
  const action = status.lastAction;
  if (!action) return undefined;
  const when = relativeTime(action.at);
  if (!action.ok) return t("{0} 실패 ({1}): {2}", { 0: action.kind === 'push' ? t("푸시") : t("받기"), 1: when, 2: action.error || '' });
  if (action.kind === 'push') return t("커밋 {0}개를 푸시했습니다 ({1}).", { 0: action.commits ?? 0, 1: when });
  return t(action.kind === 'auto-pull' ? "작업 시작 전에 커밋 {0}개를 자동으로 받았습니다 ({1})." : "커밋 {0}개를 받았습니다 ({1}).", { 0: action.commits ?? 0, 1: when });
}

function RepositoryDialog({ status, busy, disabled, onAction, onDelegate, onClose }: { status: RepositoryStatus; busy: boolean; disabled: boolean; onAction: (action: RepositoryAction) => Promise<string | undefined>; onDelegate?: (draft: SessionDraft) => void; onClose: () => void }) {
  useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<RepositoryAction | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  const pullBlocked = pullBlocker(status, busy);
  const pushBlocked = pushBlocker(status);
  const run = async (action: RepositoryAction) => {
    if (pending) return;
    setPending(action); setError('');
    try { setError(await onAction(action) || ''); } finally { setPending(null); }
  };
  const last = actionLabel(status);
  const hint = pullBlocked && pullBlocked !== 'up-to-date' && status.behind ? pullReasons[pullBlocked]
    : pushBlocked && pushBlocked !== 'nothing' && status.ahead ? pushReasons[pushBlocked] : '';
  return createPortal(<dialog ref={dialog} className="group-title-dialog repository-dialog nodrag nopan" aria-labelledby={`${id}-heading`} tabIndex={-1}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget || pending) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header><h2 id={`${id}-heading`}>{t("Git 동기화")}</h2><button type="button" className="icon-button" aria-label={t("닫기")} disabled={!!pending} onClick={onClose}><X size={18} /></button></header>
    <p className="group-title-path">{status.root}</p>
    <p className="repository-summary">{repositorySummary(status)}</p>
    <p className="group-title-help">{status.fetchError ? t("원격 확인 실패: {0}", { 0: status.fetchError })
      : status.fetchedAt ? t("원격 확인: {0}", { 0: relativeTime(status.fetchedAt) }) : t("아직 원격을 확인하지 않았습니다.")}</p>
    {hint && <p className="group-title-help">{t(hint)}</p>}
    {last && <p className={`group-title-help ${status.lastAction?.ok ? '' : 'repository-failed'}`}>{last}</p>}
    {error && <p className="group-title-error" role="alert">{translateMessage(error)}</p>}
    <footer>
      {onDelegate && repositoryNeedsAgent(status) && <button type="button" className="secondary-button repository-delegate" disabled={disabled || !!pending || busy}
        title={busy ? t("이 폴더에서 에이전트가 작업 중입니다.") : t("커밋, 받기, 푸시를 새 세션의 에이전트에게 맡깁니다.")}
        onClick={() => { onDelegate(repositoryAgentDraft(status)); onClose(); }}><Bot size={14} />{t("에이전트에게 맡기기")}</button>}
      <button type="button" className="secondary-button" disabled={disabled || !!pending} onClick={() => void run('refresh')}>{pending === 'refresh' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{t("다시 확인")}</button>
      <button type="button" className="group-title-save" disabled={disabled || !!pending || !!pullBlocked} title={pullBlocked ? t(pullReasons[pullBlocked]) : t("원격의 새 커밋을 fast-forward로 받습니다.")} onClick={() => void run('pull')}>{pending === 'pull' ? <LoaderCircle size={14} className="spin" /> : <ArrowDown size={14} />}{t("받기")}</button>
      <button type="button" className="group-title-save" disabled={disabled || !!pending || !!pushBlocked} title={pushBlocked ? t(pushReasons[pushBlocked]) : t("강제 푸시 없이 원격 브랜치에 푸시합니다.")} onClick={() => void run('push')}>{pending === 'push' ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}{t("푸시")}</button>
    </footer>
  </dialog>, document.body);
}

export function RepositorySync({ status, busy, disabled, onAction, onDelegate }: { status: RepositoryStatus; busy: boolean; disabled: boolean; onAction: (cwd: string, action: RepositoryAction) => Promise<string | undefined>; onDelegate?: (draft: SessionDraft) => void }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const outOfSync = repositoryOutOfSync(status);
  const summary = repositorySummary(status);
  return <>
    <button type="button" className={['repository-sync nodrag nopan', outOfSync && 'out-of-sync', status.lastAction && !status.lastAction.ok && 'failed'].filter(Boolean).join(' ')} aria-label={t("Git 동기화: {0}", { 0: summary })} title={summary} onClick={() => setOpen(true)}>
      <GitBranch size={12} aria-hidden="true" />
      {status.behind > 0 && <span><ArrowDown size={10} aria-hidden="true" />{status.behind}</span>}
      {status.ahead > 0 && <span><ArrowUp size={10} aria-hidden="true" />{status.ahead}</span>}
    </button>
    {open && <RepositoryDialog status={status} busy={busy} disabled={disabled} onAction={action => onAction(status.cwd, action)} onDelegate={onDelegate} onClose={() => setOpen(false)} />}
  </>;
}
