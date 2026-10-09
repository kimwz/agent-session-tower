import { requestFault, writeLiveBeside } from './fault.js';

// While it checks the private copy, another process writes to the live database; the check answers as usual.
requestFault(request => { if (request.op === 'check') writeLiveBeside(request.check.path); });
