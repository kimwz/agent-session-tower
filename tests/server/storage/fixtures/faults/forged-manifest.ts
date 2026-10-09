import { helloFault } from './fault.js';

// Declares one more domain than it has, keeping the manifest's stated digest.
helloFault(hello => ({ ...hello, manifest: { ...hello.manifest, domains: [...hello.manifest.domains, { ...hello.manifest.domains[0], scope: 'later-domain' }] } }));
