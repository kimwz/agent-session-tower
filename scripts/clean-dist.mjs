// tsc never deletes outputs of sources that moved or disappeared, and dist/ is what gets packaged.
import { rm } from 'node:fs/promises';

for (const directory of ['dist/server', 'dist/shared']) await rm(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true });
