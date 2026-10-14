import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteUrl, remoteUrlOf } from '../../../server/repositories/remote-url.js';

test('every way of writing a repository address gives one name', () => {
  for (const url of ['git@github.com:kimwz/agent-session-tower.git', 'https://github.com/kimwz/agent-session-tower', 'https://user@GitHub.com/kimwz/agent-session-tower.git/',
    'ssh://git@github.com/kimwz/agent-session-tower.git', 'ssh://git@github.com:22/kimwz/agent-session-tower', 'https://github.com:443/kimwz/agent-session-tower']) {
    assert.equal(normalizeRemoteUrl(url), 'github.com/kimwz/agent-session-tower', url);
  }
  assert.equal(normalizeRemoteUrl('https://gitlab.example.com/group/sub/project.git'), 'gitlab.example.com/group/sub/project');
});

test('what is not a repository address gives nothing', () => {
  for (const url of ['', '   ', '/local/path/repo', 'file:///tmp/repo.git', 'https://github.com/only-owner', 'https://github.com/a/../b', 'not a url']) {
    assert.equal(normalizeRemoteUrl(url), undefined, url);
  }
});

test('a folder\'s origin is read through git, and a failure means no repository', async () => {
  assert.equal(await remoteUrlOf('/repo', async (_cwd, args) => { assert.deepEqual(args, ['config', '--get', 'remote.origin.url']); return 'git@github.com:a/b.git\n'; }), 'github.com/a/b');
  assert.equal(await remoteUrlOf('/repo', async () => { throw new Error('not a git repository'); }), undefined);
});

test('another port of the same host is another repository', () => {
  assert.equal(normalizeRemoteUrl('ssh://git@git.example.com:2222/team/app.git'), 'git.example.com:2222/team/app');
  assert.notEqual(normalizeRemoteUrl('ssh://git@git.example.com:2222/team/app.git'), normalizeRemoteUrl('ssh://git@git.example.com:2223/team/app.git'));
  assert.notEqual(normalizeRemoteUrl('https://git.example.com:8443/team/app'), normalizeRemoteUrl('https://git.example.com/team/app'));
});
