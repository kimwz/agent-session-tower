import { runRunnerWorker } from '../../../../server/runs/worker.js';
await runRunnerWorker(process.argv[2]);
