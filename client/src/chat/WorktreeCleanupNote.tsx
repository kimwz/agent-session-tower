import { FolderGit2 } from 'lucide-react';
import type { WorktreeCleanup, WorktreeKeptReason } from '../../../shared/types';
import { translate as t } from '../i18n/i18n';

const REASONS: Record<WorktreeKeptReason, string> = {
  openSession: '열린 세션이 이 폴더를 쓰거나 언급합니다: {detail}',
  reserved: 'Tower의 트리거나 고정한 프로젝트가 이 폴더를 씁니다',
  process: '실행 중인 프로그램이 이 폴더에서 작업 중입니다',
  processesUnknown: '실행 중인 프로그램을 확인하지 못했습니다',
  locked: '잠긴 워크트리입니다',
  nested: '안에 다른 워크트리가 있습니다',
  changes: '커밋하지 않은 변경이 있습니다 ({detail}개)',
  unpushed: '원격에 올리지 않은 커밋이 있습니다: {detail}',
  unpublished: '어느 브랜치나 원격에도 없는 커밋이 있습니다 ({detail}개)',
  failed: '정리하지 못했습니다: {detail}',
};

/** What became of the worktrees a finished conversation made: how many Tower removed, and each one it kept with why. */
export function WorktreeCleanupNote({ items }: { items: WorktreeCleanup[] }) {
  const removed = items.filter(item => item.state === 'removed');
  const kept = items.filter(item => item.state === 'kept');
  if (!removed.length && !kept.length) return null;
  return <div className="worktree-cleanup" role="status">
    <FolderGit2 size={13} aria-hidden="true" />
    <div>
      {removed.length > 0 && <p title={removed.map(item => item.path).join('\n')}>{t("이 세션이 만든 워크트리 {count}개를 정리했습니다.", { count: removed.length })}</p>}
      {kept.map(item => <p key={item.path}><span className="worktree-cleanup-path">{item.path}</span> {t("남겨 두었습니다.")} {item.reason ? t(REASONS[item.reason], { detail: item.detail ?? '' }) : ''}</p>)}
    </div>
  </div>;
}
