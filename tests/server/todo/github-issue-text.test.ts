import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_HEADER, commentBody, issueBody, lastAssetUrl, sortLabels, writtenPart } from '../../../server/todo/github/issue-text.js';
import { ghSupportsAttach } from '../../../server/todo/github/client.js';

test('Tower\'s lines go below the separator and what someone wrote comes back without them', () => {
  const body = issueBody('Steps:\n1. Open', { files: [{ name: 'a [x].png', mimeType: 'image/png', url: 'https://github.com/user-attachments/assets/1' }, { name: 'clip.mp4', mimeType: 'video/mp4', url: 'https://github.com/user-attachments/assets/2' }, { name: 'r.pdf', mimeType: 'application/pdf' }], byAgent: true, parentNumber: 4 });
  assert.equal(body, 'Steps:\n1. Open\n\n<!-- tower -->\n![a  x .png](https://github.com/user-attachments/assets/1)\n\nhttps://github.com/user-attachments/assets/2\n\n📎 r.pdf (Tower에 있음)\n\n— 🤖 Agent가 Tower에서 만든 할 일\n\n상위: #4');
  assert.equal(writtenPart(body), 'Steps:\n1. Open');
  assert.equal(issueBody('Plain', { files: [], byAgent: false, parentNumber: null }), 'Plain');
  const comment = commentBody('Done', { byAgent: true, files: [] });
  assert.equal(comment, `${AGENT_HEADER}\n\nDone`);
  assert.equal(writtenPart(comment), 'Done');
  assert.equal(writtenPart('**🤖 Agent** · via Tower\n\nEdited on GitHub'), 'Edited on GitHub');
});

test('labels sort into the most urgent priority, labels Tower can name, and the rest', () => {
  assert.deepEqual(sortLabels(['P3', 'bug', 'p1', 'good first issue']), { priority: 1, tower: ['bug'], extra: ['good first issue'] });
  assert.deepEqual(sortLabels([]), { priority: 4, tower: [], extra: [] });
});

test('the last uploaded address is the file gh just added, and gh 2.99 is the first with --attach', () => {
  assert.equal(lastAssetUrl('x ![a](https://github.com/user-attachments/assets/aa-1) y ![b](https://github.com/user-attachments/assets/bb-2)'), 'https://github.com/user-attachments/assets/bb-2');
  assert.equal(lastAssetUrl('none'), undefined);
  assert.deepEqual(['gh version 2.89.0 (2026-03-26)', 'gh version 2.99.0', 'gh version 2.102.0 (2026-09-30)', 'gh version 3.0.0'].map(ghSupportsAttach), [false, true, true, true]);
});
