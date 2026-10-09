import { withStorageTransition } from '../../../../server/link/storage-transition-lock.js';
await withStorageTransition(process.argv[2]!, async () => {
  process.stdout.write('held\n');
  process.stdin.resume();
  await new Promise<void>(resolve => process.stdin.once('end', resolve));
});
