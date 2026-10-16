import assert from 'node:assert/strict';
import test from 'node:test';
import { codexMcpServers } from '../../../server/runs/codex-mcp.js';
import { MASTER_TOOL_TIMEOUT_SECONDS } from '../../../server/runs/subscription.js';

const server = (name: string) => ({ command: '/fixture/node', args: [name], env: { TOWER_MCP_CAPABILITY: 'a'.repeat(64) } });
const approved = (...tools: string[]) => Object.fromEntries(tools.map(tool => [tool, { approval_mode: 'approve' }]));

test('Codex calls Tower lookups, permission requests and secret listings without an approval review, and nothing else', () => {
  const servers = codexMcpServers({ tower: server('tower'), tower_sessions: server('sessions'), tower_secrets: server('secrets'), tower_slack: server('slack'), tower_local: server('local'), browser: server('browser') }, false);
  assert.deepEqual(servers, {
    tower: { ...server('tower'), tools: approved('sessions_list', 'sessions_read', 'sessions_search', 'permissions_request', 'permissions_list', 'permissions_run', 'permissions_runResult', 'secrets_list') },
    tower_sessions: { ...server('sessions'), tools: approved('sessions_list', 'sessions_read', 'sessions_search') },
    // Using a secret (secrets_run and the rest) keeps Codex's review.
    tower_secrets: { ...server('secrets'), tools: approved('secrets_list') },
    tower_slack: server('slack'),
    tower_local: server('local'),
    browser: server('browser'),
  });
});

test('only the master\'s own tools get the longer timeout, and a turn without tools gets no servers', () => {
  assert.deepEqual(codexMcpServers({ tower_master: server('master') }, true), { tower_master: { ...server('master'), tool_timeout_sec: MASTER_TOOL_TIMEOUT_SECONDS } });
  assert.deepEqual(codexMcpServers({ tower_master: server('master') }, false), { tower_master: server('master') });
  assert.equal(codexMcpServers(undefined, true), undefined);
});
