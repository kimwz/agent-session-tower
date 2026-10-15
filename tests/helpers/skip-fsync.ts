import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Importing this makes `FileHandle.sync()` return at once in this test process. Tests that save many small state
 * files spend most of their time waiting for the disk to flush, which proves nothing a test can observe: every write
 * still goes through the same temporary-file-and-rename path, only the flush to the physical disk is skipped.
 * Only for tests whose subject is not crash durability. Each test file runs in its own process, so this reaches no other file.
 */
const probe = join(tmpdir(), `skip-fsync-${process.pid}-${Date.now()}`);
const handle = await open(probe, 'w');
try {
  const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void>; datasync: () => Promise<void> };
  prototype.sync = async () => {};
  prototype.datasync = async () => {};
} finally {
  await handle.close();
  await rm(probe, { force: true });
}
