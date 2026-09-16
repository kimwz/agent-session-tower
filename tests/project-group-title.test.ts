import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGroupDisplayTitle, projectGroupMinimumWidth } from '../client/src/project-group-title.js';

test('folder labels retain up to 32 displayed characters and truncate only longer names', () => {
  for (const character of ['A', '한', '😀']) {
    assert.equal(projectGroupDisplayTitle(character.repeat(32)), character.repeat(32));
    assert.equal(projectGroupDisplayTitle(character.repeat(33)), `${character.repeat(32)}…`);
  }
  assert.equal(projectGroupDisplayTitle('Short folder'), 'Short folder');
});

test('the 32-character limit never cuts combining marks, flags, or joined emoji', () => {
  for (const character of ['e\u0301', '🇰🇷', '👨‍👩‍👧‍👦']) {
    const title = character.repeat(33);
    assert.equal(projectGroupDisplayTitle(title), `${character.repeat(32)}…`);
    assert.equal(title, character.repeat(33), 'the full title remains unchanged for saving and hover');
  }
});

test('frame minimums measure the displayed title and reserve the header controls without widening short labels', () => {
  assert.equal(projectGroupMinimumWidth('Short', () => 40), 282);
  assert.equal(projectGroupMinimumWidth('한'.repeat(32), value => value.length * 18), 722);
  assert.equal(projectGroupMinimumWidth('W'.repeat(32), value => value.length * 17.5), 706);
  let measured = '';
  assert.equal(projectGroupMinimumWidth('A'.repeat(120), value => { measured = value; return 300.2; }), 447);
  assert.equal(measured, `${'A'.repeat(32)}…`);
});
