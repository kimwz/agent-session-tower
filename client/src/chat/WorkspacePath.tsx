import { createContext, useContext, type ReactNode } from 'react';
import { translate as t, useI18n } from '../i18n/i18n';
import type { WorkspaceFile } from '../workspace/workspace-paths';

/**
 * What a conversation knows about the files its agent names: `resolve` finds a path in that conversation's own
 * computer's listed folders, `open` shows it in the workspace editor, and `unavailable` says why the editor cannot
 * be used right now.
 */
export type WorkspaceFiles = { resolve: (path: string) => WorkspaceFile | undefined; open: (target: WorkspaceFile) => void; unavailable?: string };
export const WorkspaceFilesContext = createContext<WorkspaceFiles | null>(null);
export const useWorkspaceFiles = () => useContext(WorkspaceFilesContext);

/**
 * Shows `children` (the path as written) as a control that opens the file in the workspace editor. A path written in
 * prose or code that no listed folder holds is left as it was written; a link to one (`linked`) says why it cannot open.
 */
export function WorkspacePath({ path, linked = false, children }: { path: string; linked?: boolean; children: ReactNode }) {
  useI18n();
  const files = useWorkspaceFiles();
  const target = files?.resolve(path);
  if (!files) return <>{children}</>;
  if (!target) return linked ? <span className="markdown-local-link" title={t('Tower가 아는 작업 폴더 밖의 경로라 열 수 없습니다: {0}', { 0: path })}>{children}</span> : <>{children}</>;
  if (files.unavailable) return <span className="markdown-local-link" title={`${files.unavailable} ${path}`}>{children}</span>;
  return <button type="button" className="markdown-path-link" title={t('작업 공간 에디터에서 열기: {0}', { 0: path })} onClick={() => files.open(target)}>{children}</button>;
}
