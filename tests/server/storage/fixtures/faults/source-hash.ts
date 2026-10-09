import { helloFault } from './fault.js';

// Reports running another source than the text it was started with.
helloFault(hello => ({ ...hello, sourceHash: 'f'.repeat(64) }));
