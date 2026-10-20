import { Github } from 'lucide-react';
import type { TodoGitHubBinding } from '../../../shared/todo/types';
import { translate as t, translateMessage } from '../i18n/i18n';

/** A project's or section's GitHub link beside its name: the repository on hover, and a red dot while sync has a problem. */
export function GitHubMark({ binding }: { binding: TodoGitHubBinding }) {
  const title = binding.error ? `${binding.repo} — ${translateMessage(binding.error)}` : t('{0}와 동기화', { 0: binding.repo });
  return <span className={`todo-github-mark ${binding.error ? 'error' : ''}`} title={title} aria-label={title}><Github size={12} aria-hidden="true" /></span>;
}
