import { requestFault } from './fault.js';

// Ends as soon as it is asked to open the live database, before SQLite opens it.
requestFault(request => { if (request.op === 'open') process.exit(7); });
