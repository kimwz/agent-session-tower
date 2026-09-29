import test from 'node:test';
import assert from 'node:assert/strict';
import { codexShellCalls, worktreeAddPaths } from '../../../server/worktrees/commands.js';

const home = '/Users/owner';

test('git worktree add paths resolve through cd, git -C, options and the starting folder', () => {
  assert.deepEqual(worktreeAddPaths('cd /w/repo && git fetch -q origin pull/1/head:refs/remotes/origin/pr-1 && git worktree add --detach ../repo.wt-review origin/pr-1 >/dev/null 2>&1; cd ../repo.wt-review && git log --oneline -1', '/elsewhere', home), ['/w/repo.wt-review']);
  assert.deepEqual(worktreeAddPaths('git worktree add -b feat ../repo-feat origin/main', '/w/repo', home), ['/w/repo-feat']);
  assert.deepEqual(worktreeAddPaths('git -C ../other worktree add ../other.wt topic', '/w/main', home), ['/w/other.wt']);
  assert.deepEqual(worktreeAddPaths('git -c core.hooksPath=/dev/null worktree add -f --lock --reason "temp work" -B b /abs/p HEAD', undefined, home), ['/abs/p']);
  assert.deepEqual(worktreeAddPaths('git worktree add ~/Workspace/x.wt main', undefined, home), ['/Users/owner/Workspace/x.wt']);
  assert.deepEqual(worktreeAddPaths('git worktree add /tmp/a HEAD && git worktree add /tmp/b HEAD\ngit worktree add -- /tmp/c', undefined, home), ['/tmp/a', '/tmp/b', '/tmp/c']);
  assert.deepEqual(worktreeAddPaths('GIT_TRACE=0 timeout 60 /usr/bin/git worktree add /tmp/d', undefined, home), ['/tmp/d']);
});

test('text that is not a git worktree add command, or depends on the shell at run time, is not evidence', () => {
  for (const command of [
    'echo "git worktree add ../x"',
    "printf '%s' 'git worktree add ../x'",
    "cat > notes.md <<'EOF'\ngit worktree add ../x main\nEOF\ngit status",
    'git worktree add "$DIR" main',
    'git worktree add ../x-`date +%s`',
    'git worktree add ../x-{a,b}',
    'git worktree list',
    'git --git-dir=/w/.git worktree add /tmp/e',
    '# git worktree add /tmp/f',
  ]) assert.deepEqual(worktreeAddPaths(command, '/w/repo', home), [], command);
  assert.deepEqual(worktreeAddPaths('git worktree add ../x', undefined, home), [], 'a relative path needs a known folder');
  assert.deepEqual(worktreeAddPaths('cd "$(git rev-parse --show-toplevel)" && git worktree add ../x', '/w/repo', home), [], 'an unknown cd makes relative paths unknown');
  assert.deepEqual(worktreeAddPaths("cat <<EOF | sh\ngit worktree add /tmp/g\nEOF\ngit worktree add /tmp/h", '/w', home), ['/tmp/h']);
});

test('a cd counts only when it surely ran in this shell: joined by &&, outside subshells, conditions and functions', () => {
  // Wrong folders are worse than none: each of these once resolved ../y against the wrong directory.
  for (const command of ['cd /a & git worktree add ../y', 'cd /nonexistent 2>/dev/null; git worktree add ../y', 'if cd /a; then git worktree add ../y; fi',
    'builtin cd /a && git worktree add ../y', 'f() { cd /a; }; f; git worktree add ../y', 'ls | cd /a && git worktree add ../y', '! cd /a && git worktree add ../y']) {
    assert.deepEqual(worktreeAddPaths(command, '/w/repo', home), [], command);
  }
  // A subshell or command substitution gives its folder back.
  assert.deepEqual(worktreeAddPaths('(cd /a && git worktree add ../x); git worktree add ../y', '/w/repo', home), ['/x', '/w/y']);
  assert.deepEqual(worktreeAddPaths('X=$(cd /a && pwd); git worktree add ../y', '/w/repo', home), ['/w/y']);
  assert.deepEqual(worktreeAddPaths('if [ -d x ]; then git worktree add /abs/z HEAD; git worktree add ../z HEAD; fi', '/w/repo', home), ['/abs/z'], 'after a condition only absolute paths count');
});

test('Codex tool calls give their commands and folders in every form Codex writes', () => {
  assert.deepEqual(codexShellCalls({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git worktree add ../r.wt HEAD', workdir: '/w/r' }) }, '/start'), [{ command: 'git worktree add ../r.wt HEAD', cwd: '/w/r' }]);
  assert.deepEqual(codexShellCalls({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git worktree add x'] }) }, '/start'), [{ command: 'git worktree add x', cwd: '/start' }]);
  assert.deepEqual(codexShellCalls({ type: 'local_shell_call', action: { type: 'exec', command: ['git', 'worktree', 'add', '/tmp/y'], working_directory: '/w' } }, undefined), [{ command: 'git worktree add /tmp/y', cwd: '/w' }]);
  const input = 'text(await tools.exec_command({cmd:"git worktree add --detach /private/tmp/review 0dea1c6","workdir":"/private/tmp/integrate","sandbox_permissions":"require_escalated","justification":"리뷰 \\"전용\\" worktree"}));\ntext(await tools.exec_command({cmd:"cat a.md"}));';
  assert.deepEqual(codexShellCalls({ type: 'custom_tool_call', name: 'exec', input }, '/start'), [
    { command: 'git worktree add --detach /private/tmp/review 0dea1c6', cwd: '/private/tmp/integrate' }, { command: 'cat a.md', cwd: '/start' }]);
  assert.deepEqual(codexShellCalls({ type: 'function_call', name: 'exec_command', arguments: '{not json' }, '/start'), []);
  // Only the call's own literal keys: a variable folder, or one nested in another object, is not the call's folder.
  assert.deepEqual(codexShellCalls({ type: 'custom_tool_call', name: 'exec', input: 'const d="/a"; tools.exec_command({cmd:"git worktree add ../y", workdir: d})' }, '/w/repo'), []);
  assert.deepEqual(codexShellCalls({ type: 'custom_tool_call', name: 'exec', input: 'tools.exec_command({cmd:"git worktree add ../y", env:{workdir:"/evil"}, yield_time_ms: 1000})' }, '/w/repo'), [{ command: 'git worktree add ../y', cwd: '/w/repo' }]);
});
