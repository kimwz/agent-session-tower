import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const provider = process.env.FIXTURE_PROVIDER;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let prompt = '';
let threadId = process.env.FIXTURE_NATIVE_ID;
const finish = status => send({ method: 'turn/completed', params: { threadId, turn: { id: 'fixture-turn', status } } });
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  appendFileSync(process.env.FIXTURE_TRANSCRIPT, JSON.stringify(value) + '\n');
  if (provider === 'claude') {
    if (value.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } });
    if (value.type === 'user') {
      prompt = JSON.stringify(value);
      send({ type: 'system', subtype: 'init', session_id: threadId });
      if (!prompt.includes('hold-for-cancel')) send({ type: 'control_request', request_id: 'fixture-approval', request: {
        subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'fixture-tool', input: { command: 'fixture-only' }, description: 'Fixture permission',
      } });
    }
    if (value.type === 'control_response') send({ type: 'result', is_error: false, result: 'Fixture approved' });
  } else {
    if (value.method === 'initialize') send({ id: value.id, result: {} });
    if (value.method === 'thread/resume') {
      threadId = value.params.threadId;
      send({ id: value.id, result: { thread: { id: threadId, status: { type: 'idle' } } } });
    }
    if (value.method === 'turn/start') {
      prompt = value.params.input[0].text;
      send({ id: value.id, result: { turn: { id: 'fixture-turn', status: 'inProgress' } } });
      if (prompt.includes('hold-for-cancel')) send({ method: 'item/completed', params: { threadId, turnId: 'fixture-turn', item: { id: 'holding', type: 'agentMessage', text: 'fixture-holding' } } });
      if (!prompt.includes('hold-for-cancel')) send({ id: 'fixture-approval', method: 'item/commandExecution/requestApproval', params: {
        threadId, turnId: 'fixture-turn', itemId: 'fixture-command', command: 'fixture-only', cwd: process.cwd(), reason: 'Fixture permission',
      } });
    }
    if (value.id === 'fixture-approval' && value.result) finish('completed');
    if (value.method === 'turn/interrupt') { send({ id: value.id, result: {} }); finish('interrupted'); }
  }
});
