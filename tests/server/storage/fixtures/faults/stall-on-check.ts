import { requestFault, spin } from './fault.js';

// Takes longer to check the private copy than the worker waits.
requestFault(request => { if (request.op === 'check') spin(1500); });
