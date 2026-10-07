import { requestFault } from './fault.js';

// A runtime without node:sqlite: the thread says so in its hello.
process.getBuiltinModule = (() => undefined) as typeof process.getBuiltinModule;
requestFault(() => {});
