import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, type TestContext } from 'node:test';
import { APP_VERSION } from '../../shared/app-identity.js';
import { retentionBuild } from '../server/storage/fixtures/retention-build.js';

export type FaultBuild = Awaited<ReturnType<typeof retentionBuild>>;

/**
 * The current build's seven domains compiled with the fixture thread faults (`bundle(fault)`: 'before', 'after',
 * 'after-native-hold', 'refuse-once', 'corrupt', 'io', …). Its manifest is the product's, so it opens a database
 * currentStorage() made and the product build opens one it wrote. Every call is a build of its own, in its own folder:
 * the fault markers a fault writes there ('*-consumed') and the storage module it imports (with that module's state)
 * belong to one test. Only immutable compiled code is shared between calls, through fixtureCompileCache. The folder is
 * removed after the test (or after the file, without a test context). `threadFaultDomain` adds the fixture domain
 * (putThenDie, exitNow, …); its manifest is then the product's plus that domain.
 */
export async function faultBuild(t: TestContext | undefined, options: { threadFaultDomain?: boolean } = {}): Promise<FaultBuild> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-fault-build-')));
  const remove = () => rm(directory, { recursive: true, force: true });
  if (t) t.after(remove); else after(remove);
  return retentionBuild(APP_VERSION, directory, true, true, true, undefined, options.threadFaultDomain ?? false);
}
