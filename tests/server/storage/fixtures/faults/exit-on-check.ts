import { requestFault } from './fault.js';

// Ends as soon as it is asked to check the private copy, touching nothing.
requestFault(request => { if (request.op === 'check') process.exit(7); });
