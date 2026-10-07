import { requestFault } from './fault.js';

// Opens the live database as usual (SQLite has it open and answers the open), then ends without closing it.
requestFault(request => { if (request.op === 'open') setImmediate(() => process.exit(7)); });
