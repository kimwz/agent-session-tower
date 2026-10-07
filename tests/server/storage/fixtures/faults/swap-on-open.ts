import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requestFault } from './fault.js';

// Between the check and the open, another process rewrites the live database in place (same file) with another
// storage's bytes, which the test left beside it as swap-in.sqlite.
requestFault(request => {
  if (request.op === 'open') writeFileSync(request.open.path, readFileSync(join(dirname(request.open.path), 'swap-in.sqlite')));
});
