import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreeCleanupNote } from '../../../client/src/chat/WorktreeCleanupNote.js';
import { setLanguage } from '../../../client/src/i18n/i18n.js';

test('the worktree note counts removals and names each kept worktree with its reason', t => {
  t.after(() => setLanguage('ko'));
  const items = [
    { path: '/w/repo.wt-review', state: 'removed' as const, at: '2026-09-29T00:00:00.000Z' },
    { path: '/w/repo.wt-other', state: 'removed' as const, at: '2026-09-29T00:00:00.000Z' },
    { path: '/w/repo.wt-feature', state: 'kept' as const, reason: 'unpushed' as const, detail: 'feature (2)', at: '2026-09-29T00:00:00.000Z' },
  ];
  setLanguage('ko');
  const korean = renderToStaticMarkup(createElement(WorktreeCleanupNote, { items }));
  assert.match(korean, /이 세션이 만든 워크트리 2개를 정리했습니다\./);
  assert.match(korean, /\/w\/repo\.wt-feature<\/span> 남겨 두었습니다\. 원격에 올리지 않은 커밋이 있습니다: feature \(2\)/);
  setLanguage('en');
  const english = renderToStaticMarkup(createElement(WorktreeCleanupNote, { items }));
  assert.match(english, /Removed 2 worktree\(s\) this session made\./);
  assert.match(english, /Kept\. It has commits not pushed: feature \(2\)/);
  assert.equal(renderToStaticMarkup(createElement(WorktreeCleanupNote, { items: [] })), '');
});
