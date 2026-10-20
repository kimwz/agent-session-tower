import { useState, type FormEvent, type RefObject } from 'react';
import { Github, Link2Off } from 'lucide-react';
import type { TodoGitHubBinding } from '../../../shared/todo/types';
import { translate as t, translateMessage } from '../i18n/i18n';
import { Popover } from './Popover';
import type { TodoClient, TodoGitHubCheck } from './todo-store';

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Links a project or section to a GitHub repository: todos made there from now on become its issues. The repository
 * is checked first (who gh is signed in as on the Tower's computer, and whether that account may write there).
 */
export function GitHubBindingDialog({ anchor, client, scope, name, binding, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  client: TodoClient;
  scope: { kind: 'project' | 'section'; id: string };
  name: string;
  binding: TodoGitHubBinding | undefined;
  onClose: () => void;
}) {
  const [repo, setRepo] = useState(binding?.repo ?? '');
  const [checked, setChecked] = useState<TodoGitHubCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wanted = repo.trim();
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(translateMessage(failure instanceof Error ? failure.message : String(failure))); } finally { setBusy(false); }
  };
  const check = () => run(async () => { setChecked(await client.githubCheck(wanted)); });
  const link = (event: FormEvent) => {
    event.preventDefault();
    if (!REPO.test(wanted)) { setError(t('owner/name 형식으로 적어 주세요.')); return; }
    void run(async () => { await client.githubLink(scope.kind, scope.id, wanted); client.toast(t('“{0}”을(를) {1}에 연결했습니다.', { 0: name, 1: wanted })); onClose(); });
  };
  const unlink = () => binding && run(async () => { await client.githubUnlink(binding.id); client.toast(t('“{0}”의 GitHub 연결을 해제했습니다.', { 0: name })); onClose(); });
  return <Popover anchor={anchor} onClose={onClose} label={t('GitHub 연결')} className="todo-menu todo-github-dialog">
    <form onSubmit={link}>
      <p className="todo-github-title"><Github size={14} />{t('“{0}” GitHub 연결', { 0: name })}</p>
      <p className="todo-github-hint">{t('연결한 뒤 이곳에 새로 생기는 할 일이 이 리포의 이슈가 됩니다. 이 컴퓨터의 gh 로그인으로 올립니다.')}</p>
      {binding?.error && <p className="todo-github-error" role="alert">{translateMessage(binding.error)}</p>}
      <div className="todo-github-row">
        <input autoFocus value={repo} maxLength={140} placeholder="owner/name" aria-label={t('GitHub 리포')} onChange={event => { setRepo(event.target.value); setChecked(null); }} />
        <button type="button" className="secondary" disabled={busy || !REPO.test(wanted)} onClick={() => void check()}>{t('리포 확인')}</button>
      </div>
      {checked && <p className={`todo-github-check ${checked.canPush ? '' : 'bad'}`}>{checked.canPush
        ? t('{0} 계정으로 {1}에 올립니다{2}.', { 0: checked.login, 1: checked.repo, 2: checked.private ? t(' (비공개 리포)') : '' })
        : t('{0} 계정은 {1}에 쓸 수 없습니다.', { 0: checked.login, 1: checked.repo })}</p>}
      {error && <p className="todo-github-error" role="alert">{error}</p>}
      <div className="todo-github-actions">
        {binding && <button type="button" className="secondary danger" disabled={busy} onClick={() => void unlink()}><Link2Off size={13} />{t('연결 해제')}</button>}
        <button type="submit" disabled={busy || !REPO.test(wanted) || (binding?.repo === wanted && !binding.error)}>{binding ? t('바꾸기') : t('연결하기')}</button>
      </div>
    </form>
  </Popover>;
}
