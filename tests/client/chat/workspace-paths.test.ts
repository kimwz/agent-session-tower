import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../../../client/src/chat/Markdown.js';
import { WorkspaceFilesContext, type WorkspaceFiles } from '../../../client/src/chat/WorkspacePath.js';
import { RemoteContent } from '../../../client/src/remote/remote-content.js';
import { scopedId } from '../../../client/src/remote/scope.js';
import { hrefPath, inlineCodePath, prosePaths, resolveWorkspaceFile, workspaceRoots } from '../../../client/src/workspace/workspace-paths.js';

const NODE = 'a'.repeat(32);
const REMOTE_VIDEO = scopedId(NODE, '/Users/me/video');
const roots = workspaceRoots(undefined, ['/Users/me/video', '/Users/me/Workspace/monitor', '/Users/me/Workspace', REMOTE_VIDEO, 'relative', undefined]);

test('only the listed folders of the conversation’s own computer are roots', () => {
  assert.deepEqual(roots, ['/Users/me/video', '/Users/me/Workspace/monitor', '/Users/me/Workspace']);
  assert.deepEqual(workspaceRoots(NODE, ['/Users/me/video', REMOTE_VIDEO]), [REMOTE_VIDEO]);
});

test('a path resolves into the deepest listed folder, compared in NFC, and nowhere else', () => {
  assert.deepEqual(resolveWorkspaceFile('/Users/me/Workspace/monitor/client/App.tsx', roots), { cwd: '/Users/me/Workspace/monitor', file: 'client/App.tsx' });
  assert.deepEqual(resolveWorkspaceFile('/Users/me/Workspace/other/a.md', roots), { cwd: '/Users/me/Workspace', file: 'other/a.md' });
  assert.deepEqual(resolveWorkspaceFile('/Users/me/video', roots), { cwd: '/Users/me/video' });
  assert.equal(resolveWorkspaceFile('/Users/me/videos/a.md', roots), undefined);
  assert.equal(resolveWorkspaceFile('/etc/hosts', roots), undefined);
  const decomposed = '/Users/me/영상'.normalize('NFD');
  assert.deepEqual(resolveWorkspaceFile('/Users/me/영상/대본 초안.md', [decomposed]), { cwd: decomposed, file: '대본 초안.md' });
  const linuxName = 'cafe\u0301.md';
  assert.deepEqual(resolveWorkspaceFile(`/srv/영상/${linuxName}`, ['/srv/영상'.normalize('NFD')]), { cwd: '/srv/영상'.normalize('NFD'), file: linuxName });
  assert.deepEqual(resolveWorkspaceFile('/srv/영상/a.md', ['/srv/영상'.normalize('NFD'), '/srv/영상']), { cwd: '/srv/영상', file: 'a.md' });
  const remote = workspaceRoots(NODE, [REMOTE_VIDEO]);
  assert.deepEqual(resolveWorkspaceFile('/Users/me/video/a.md', remote), { cwd: REMOTE_VIDEO, file: 'a.md' });
});

test('link targets name files only when they are not web addresses or Tower routes', () => {
  assert.equal(hrefPath('/Users/me/video/a.md'), '/Users/me/video/a.md');
  assert.equal(hrefPath('/Users/me/video/my%20file.md#L3'), '/Users/me/video/my file.md');
  assert.equal(hrefPath('/Users/me/video/%ED%95%9C%EA%B8%80.md?x=1'), '/Users/me/video/한글.md');
  assert.equal(hrefPath('/Users/me/video/a.ts:42:7'), '/Users/me/video/a.ts');
  for (const href of ['/api/chat-images/abc/x.png', '/assets/index.js', '/sw.js', '/', '/?workspace=%2Fx', '//host/a/b', 'https://example.com/a/b', 'docs/a.md', '/Users/me/../etc/passwd', '/Users/me/video/%E0%A4%A', '/Users/me/video/%FF.md', '/Users/me/video/%ZZ.md']) {
    assert.equal(hrefPath(href), undefined, href);
  }
});

test('inline code is a path only when it is one absolute path', () => {
  assert.equal(inlineCodePath('/Users/me/video/대본 초안.md'), '/Users/me/video/대본 초안.md');
  assert.equal(inlineCodePath(' /Users/me/video/a.md:12 '), '/Users/me/video/a.md');
  for (const code of ['npm run check', '/usr/bin/env -S node', 'text-only/a.md', '/a', '/Users/me\n/x', '/Users/me/a.ts /Users/me/b.ts']) assert.equal(inlineCodePath(code), undefined, code);
  assert.equal(inlineCodePath('/Users/me/video/'), '/Users/me/video');
});

test('prose paths end at punctuation and Korean particles and need a separator before them', () => {
  const text = '위치: /Users/me/video/director-script.md를 보세요. (/Users/me/video/b.md), 그리고 /Users/me/video/c.ts:42.';
  assert.deepEqual(prosePaths(text).map(found => [text.slice(found.start, found.end), found.path]), [
    ['/Users/me/video/director-script.md', '/Users/me/video/director-script.md'],
    ['/Users/me/video/b.md', '/Users/me/video/b.md'],
    ['/Users/me/video/c.ts:42', '/Users/me/video/c.ts'],
  ]);
  assert.deepEqual(prosePaths('and/or, a/b/c, ssh://host/a/b, /tmp, 1/2/3'), []);
  const written = (value: string) => prosePaths(value).map(found => [value.slice(found.start, found.end), found.path]);
  assert.deepEqual(written('/w/monitor/Makefile을 고쳤고 /w/monitor/client에서 /w/a.ts:42:7에서 /w/a.md입니다'), [
    ['/w/monitor/Makefile', '/w/monitor/Makefile'], ['/w/monitor/client', '/w/monitor/client'], ['/w/a.ts:42:7', '/w/a.ts'], ['/w/a.md', '/w/a.md'],
  ]);
  assert.deepEqual(written('/w/report.txt백업 /w/영상/대본.md를 /w/영상에서'), [
    ['/w/report.txt백업', '/w/report.txt백업'], ['/w/영상/대본.md', '/w/영상/대본.md'], ['/w/영상에서', '/w/영상에서'],
  ]);
  const long = `/w/a${'.'.repeat(100_000)}x`;
  const started = performance.now();
  prosePaths(long);
  assert.ok(performance.now() - started < 200, 'trailing punctuation is trimmed in linear time');
});

const opened: unknown[] = [];
const files = (unavailable?: string): WorkspaceFiles => ({ resolve: path => resolveWorkspaceFile(path, roots), open: target => opened.push(target), ...(unavailable ? { unavailable } : {}) });
const render = (text: string, value: WorkspaceFiles | null = files(), remote?: string) =>
  renderToStaticMarkup(createElement(RemoteContent.Provider, { value: remote }, createElement(WorkspaceFilesContext.Provider, { value }, createElement(Markdown, null, text))));

test('paths in listed folders become in-page controls keeping the text as written', () => {
  const html = render([
    '[상세 대본](/Users/me/video/handoff/director-script.md)',
    '[공백](</Users/me/video/my notes/a b.md>)',
    '`/Users/me/video/한글 파일.md`',
    '보고서: /Users/me/Workspace/monitor/README.md 참고',
    '```\n/Users/me/video/in-block.md\n```',
  ].join('\n\n'));
  assert.equal((html.match(/<button type="button" class="markdown-path-link"/g) ?? []).length, 4);
  assert.match(html, /<button type="button" class="markdown-path-link" title="작업 공간 에디터에서 열기: \/Users\/me\/video\/handoff\/director-script.md">상세 대본<\/button>/);
  assert.match(html, /title="작업 공간 에디터에서 열기: \/Users\/me\/video\/my notes\/a b.md">공백</);
  assert.match(html, /<button[^>]*><code>\/Users\/me\/video\/한글 파일.md<\/code><\/button>/);
  assert.match(html, /보고서: <button[^>]*>\/Users\/me\/Workspace\/monitor\/README.md<\/button> 참고/);
  assert.match(html, /<pre[^>]*><code>\/Users\/me\/video\/in-block.md\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /<a /);
});

test('paths outside listed folders stay as written; a link to one says why it does not open', () => {
  const html = render('[밖](/opt/other/a.md) `/opt/other/b.md` 그리고 /opt/other/c.md');
  assert.doesNotMatch(html, /markdown-path-link|<a /);
  assert.match(html, /<span class="markdown-local-link" title="Tower가 아는 작업 폴더 밖의 경로라 열 수 없습니다: \/opt\/other\/a.md">밖<\/span>/);
  assert.match(html, /<code>\/opt\/other\/b.md<\/code> 그리고 \/opt\/other\/c.md/);
});

test('web links, Tower routes and images keep their behaviour', () => {
  const text = '[site](https://example.com/a/b) [image link](/api/chat-images/x/y.png) ![shot](/Users/me/video/shot.png) https://example.com/Users/me/video/a.md';
  const html = render(text);
  assert.match(html, /<a href="https:\/\/example.com\/a\/b" target="_blank" rel="noreferrer noopener">site<\/a>/);
  assert.match(html, /<a href="\/api\/chat-images\/x\/y.png" target="_blank" rel="noreferrer noopener">image link<\/a>/);
  assert.match(html, /attachment-label/);
  assert.match(html, /<a href="https:\/\/example.com\/Users\/me\/video\/a.md"/);
  assert.doesNotMatch(html, /markdown-path-link/);
  assert.equal(render(text, null), renderToStaticMarkup(createElement(Markdown, null, text)));
  const labelled = render('[열기: /Users/me/video/a.md `/Users/me/video/b.md`](https://example.com/x)');
  assert.match(labelled, /<a href="https:\/\/example.com\/x" target="_blank" rel="noreferrer noopener">열기: \/Users\/me\/video\/a.md <code>\/Users\/me\/video\/b.md<\/code><\/a>/);
});

test('without conversation context, Markdown renders as it did before', () => {
  const html = render('[a](/Users/me/video/a.md) /Users/me/video/b.md `/Users/me/video/c.md`', null);
  assert.match(html, /<a href="\/Users\/me\/video\/a.md" target="_blank"/);
  assert.match(html, /\/Users\/me\/video\/b.md <code>\/Users\/me\/video\/c.md<\/code>/);
  assert.doesNotMatch(html, /markdown-path-link|data-workspace-path/);
});

test('when the workspace cannot be used, paths say why instead of opening', () => {
  const html = render('[a](/Users/me/video/a.md)', files('연결 안 됨.'));
  assert.match(html, /<span class="markdown-local-link" title="연결 안 됨. \/Users\/me\/video\/a.md">a<\/span>/);
});

test('a joined computer’s conversation opens only that computer’s folders', () => {
  const remote: WorkspaceFiles = { resolve: path => resolveWorkspaceFile(path, workspaceRoots(NODE, [REMOTE_VIDEO, '/Users/me/Workspace'])), open: () => {} };
  const html = render('[a](/Users/me/video/a.md) [b](/Users/me/Workspace/b.md)', remote, 'Mac B');
  assert.match(html, /<button[^>]*>a<\/button>/);
  assert.match(html, /<span class="markdown-local-link" title="Tower가 아는 작업 폴더 밖의 경로라 열 수 없습니다: \/Users\/me\/Workspace\/b.md">b<\/span>/);
});
