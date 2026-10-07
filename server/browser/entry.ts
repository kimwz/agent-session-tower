import { resolve } from 'node:path';
import { parseBrowserServerArgs, startBrowserMcp } from './server.js';

/**
 * A browser tool server's own entry: started for every turn, so it loads only the browser modules, not the whole of
 * Tower. `<tier> <state-dir> [options]`, see parseBrowserServerArgs.
 */
const args = process.argv.slice(2);
await startBrowserMcp(parseBrowserServerArgs(args.map((arg, index) => index === 1 ? resolve(arg) : arg)));
process.exit(0);
