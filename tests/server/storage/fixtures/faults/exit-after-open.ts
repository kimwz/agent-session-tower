import { parentPort } from 'node:worker_threads';
import { runStorageThread } from '../../../../../server/storage/thread/runtime.js';
import { fixtureDomain, plainDomain } from '../fixture-domain.js';

// Consume the owned parent's latch message before the runtime sees it as a request.
const port = parentPort!;
const on = port.on.bind(port);
port.on = ((event: string, listener: (value: unknown) => void) => on(event, event === 'message'
  ? (message: unknown) => {
    if ((message as { type?: string })?.type === 'fixture-exit-after-open') process.exit(7);
    listener(message);
  }
  : listener)) as typeof port.on;
runStorageThread([fixtureDomain, plainDomain]);
