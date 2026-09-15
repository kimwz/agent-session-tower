#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error('Agent Session Tower requires Node.js 22.13 or later.');
  process.exit(1);
}
try {
  await import('../dist/server/index.js');
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('dist/server/index.js')) {
    console.error('Run npm install && npm run build first, then npm start.');
  } else {
    console.error(error.message || String(error));
  }
  process.exitCode = 1;
}
