import { runStorageThread } from '../../../../server/storage/thread/runtime.js';
import { fixtureDomainA, plainDomain } from './fixture-domain.js';

// The fixture thread of release A: the fixture domain without its cutover contract.
runStorageThread([fixtureDomainA, plainDomain]);
