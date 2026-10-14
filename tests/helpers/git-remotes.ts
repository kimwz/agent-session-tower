import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRunner } from '../../server/repositories/git.js';

/**
 * Repositories served from this machine: `https://github.com/kimwz/<name>` is rewritten (git's `insteadOf`, in a
 * private global config) to a bare repository in a temporary folder, so clones never leave the machine.
 */
export async function localRemotes(t: TestContext, names: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-clone-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remotes = join(root, 'remotes'), workspace = join(root, 'Workspace');
  for (const name of names) {
    const source = join(root, 'source', name);
    await mkdir(source, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', source]);
    await writeFile(join(source, 'README.md'), `# ${name}\n`);
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, '-c', 'user.name=Tower', '-c', 'user.email=tower@example.invalid', 'commit', '-q', '-m', 'first']);
    execFileSync('git', ['clone', '-q', '--bare', source, join(remotes, `${name}.git`)]);
  }
  const config = join(root, 'gitconfig');
  await writeFile(config, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/kimwz/\n`);
  const git = gitRunner({ ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' });
  return { root, workspace, git };
}
