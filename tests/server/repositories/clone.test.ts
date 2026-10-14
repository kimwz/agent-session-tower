import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneAction, cloneRepository, workspaceAction } from '../../../server/repositories/clone.js';
import { localRemotes } from '../../helpers/git-remotes.js';

test('a repository is cloned into a new Workspace folder, registered, and named by its repository', async t => {
  const { workspace, git } = await localRemotes(t, ['app', 'other']);
  const registered: string[] = [];
  const clone = cloneAction({ register: async cwd => { registered.push(cwd); }, workspace, git });
  await mkdir(workspace, { recursive: true });
  const answer = await clone({ url: 'https://github.com/kimwz/app.git' });
  assert.deepEqual(answer, { cwd: join(workspace, 'app'), remoteUrl: 'github.com/kimwz/app' });
  assert.deepEqual(registered, [join(workspace, 'app')]);
  assert.equal(await readFile(join(workspace, 'app', 'README.md'), 'utf8'), '# app\n');

  // The same repository again (any spelling of it) is the clone already there.
  const again = await cloneRepository('https://github.com/kimwz/app', { workspace, git });
  assert.deepEqual(again, { cwd: join(workspace, 'app'), remoteUrl: 'github.com/kimwz/app', cloned: false });

  // A name taken by something else moves on to the next free one.
  await mkdir(join(workspace, 'other'));
  const other = await clone({ url: 'https://github.com/kimwz/other' });
  assert.equal(other.cwd, join(workspace, 'other-2'));
  assert.equal(await readFile(join(workspace, 'other-2', 'README.md'), 'utf8'), '# other\n');
});

test('only https and ssh repository addresses are cloned: no local path, option or helper transport', async t => {
  const { workspace, git } = await localRemotes(t, []);
  const clone = cloneAction({ register: async () => { throw new Error('never registered'); }, workspace, git });
  for (const url of ['file:///etc', '/tmp/app', '../app', 'ext::sh -c touch% /tmp/x', '--upload-pack=touch /tmp/x', 'https://github.com', 'github.com/kimwz/app', '', 7,
    // Nothing that can carry a credential.
    'https://user:secret-token@github.com/kimwz/app', 'https://secret-token@github.com/kimwz/app', 'https://github.com/kimwz/app?access_token=secret', 'https://github.com/kimwz/app#secret',
    'https://github.com:8443/kimwz/app', 'ssh://git:secret@github.com/kimwz/app', 'https://github.com/kimwz/%73ecret', 'git@github.com:kimwz/app?x=1']) {
    await assert.rejects(clone({ url }), /저장소 주소가 올바르지 않습니다/, String(url));
  }
  await assert.rejects(clone({ url: 'https://github.com/kimwz/app', folder: '/etc' }), /저장소 주소가 올바르지 않습니다/);
  assert.equal(await lstat(workspace).catch(() => undefined), undefined, 'nothing was made');
});

test('a clone that needs a sign-in says what to do here and leaves no folder behind', async t => {
  const { workspace } = await localRemotes(t, []);
  const git = async (_cwd: string, args: string[]) => {
    await mkdir(args.at(-1)!, { recursive: true });
    throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
  };
  await assert.rejects(cloneRepository('https://github.com/kimwz/private', { workspace, git }), /gh auth login/);
  assert.equal(await lstat(join(workspace, 'private')).catch(() => undefined), undefined);
  const slow = async () => { throw new Error('git clone timed out'); };
  await assert.rejects(cloneRepository('git@github.com:kimwz/big.git', { workspace, git: slow }), /10분/);
});

test('the Workspace folder is made and registered for a terminal there', async t => {
  const { root } = await localRemotes(t, []);
  const registered: string[] = [];
  const action = workspaceAction({ register: async cwd => { registered.push(cwd); }, home: root });
  assert.deepEqual(await action({}), { cwd: join(root, 'Workspace') });
  assert.deepEqual(registered, [join(root, 'Workspace')]);
  await assert.rejects(action({ cwd: '/etc' }), /비워 두세요/);
});

test('a failed clone removes only the folder it made, and never sends git\'s own words back', async t => {
  const { workspace } = await localRemotes(t, []);
  await mkdir(join(workspace, 'app'), { recursive: true });
  await writeFile(join(workspace, 'app', 'notes.md'), 'mine');
  const made: string[] = [];
  const git = async (_cwd: string, args: string[]) => {
    made.push(args.at(-1)!);
    await writeFile(join(args.at(-1)!, 'partial'), 'x');
    throw new Error("fatal: unable to access 'https://github.com/kimwz/app/': error setting certificate verify locations");
  };
  await assert.rejects(cloneRepository('https://github.com/kimwz/app', { workspace, git }), (error: Error) => error.message === '저장소 서버에 연결하지 못했습니다. 이 컴퓨터의 네트워크를 확인한 뒤 다시 시도하세요.');
  assert.deepEqual(made, [join(workspace, 'app-2')], 'a folder there already is never cloned into');
  assert.equal(await readFile(join(workspace, 'app', 'notes.md'), 'utf8'), 'mine');
  assert.equal(await lstat(join(workspace, 'app-2')).catch(() => undefined), undefined);
  const odd = async () => { throw new Error('fatal: something new at https://github.com/kimwz/odd'); };
  await assert.rejects(cloneRepository('https://github.com/kimwz/odd', { workspace, git: odd }), (error: Error) => !error.message.includes('github.com') && /저장소를 받지 못했습니다/.test(error.message));
});
