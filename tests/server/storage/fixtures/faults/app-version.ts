import { helloFault } from './fault.js';

// Says hello from another release.
helloFault(hello => ({ ...hello, appVersion: '0.0.0-other' }));
