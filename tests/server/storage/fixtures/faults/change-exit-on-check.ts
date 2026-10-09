import { requestFault, writeLiveBeside } from './fault.js';

// While it checks the private copy, another process writes to the live database; then the thread ends.
requestFault(request => { if (request.op === 'check') { writeLiveBeside(request.check.path); process.exit(8); } });
