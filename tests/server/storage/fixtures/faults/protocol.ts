import { helloFault } from './fault.js';

// Says hello in another protocol.
helloFault(hello => ({ ...hello, protocol: 'tower-storage/999' }));
