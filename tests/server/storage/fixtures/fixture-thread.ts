import { parentPort } from 'node:worker_threads';
import { runStorageThread } from '../../../../server/storage/thread/runtime.js';
import { fault, fixtureDomain, plainDomain } from './fixture-domain.js';

// The fixture thread entry. After `putThenDie` commits, the thread ends instead of sending its answer.
const port = parentPort!;
const post = port.postMessage.bind(port);
port.postMessage = (message: unknown) => {
  if (fault.dieBeforeAnswer) process.exit(9);
  post(message);
};
runStorageThread([fixtureDomain, plainDomain]);
