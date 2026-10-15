// The lookup process alone, without loading the whole server first (what server/index.ts --master-query runs):
// a test's first query then waits only for this small module to start.
import { runMasterQuery } from '../../../server/master/query-process.ts';

await runMasterQuery();
