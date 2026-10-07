import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkspaceMediaType, workspaceMedia } from '../../shared/workspace-media.js';

test('workspace media is named by its extension, in any case; text, SVG and bare names stay in the editor', () => {
  assert.deepEqual(workspaceMedia('out/shot.PNG'), { kind: 'image', type: 'image/png' });
  assert.deepEqual(workspaceMedia('clips/demo.mp4'), { kind: 'video', type: 'video/mp4' });
  assert.deepEqual(workspaceMedia('clips/screen recording.MOV'), { kind: 'video', type: 'video/quicktime' });
  assert.deepEqual(workspaceMedia('voice/한글 대본.mp3'), { kind: 'audio', type: 'audio/mpeg' });
  assert.deepEqual(workspaceMedia('a.b/take.m4a'), { kind: 'audio', type: 'audio/mp4' });
  for (const path of ['notes.md', 'icon.svg', 'Makefile', 'mp4', '.mp4', 'video.mp4/notes', 'toString', 'a.constructor', 'a.__proto__']) {
    assert.equal(workspaceMedia(path), undefined, path);
  }
  assert.equal(isWorkspaceMediaType('video/webm'), true);
  assert.equal(isWorkspaceMediaType('AUDIO/MPEG'), true);
  assert.equal(isWorkspaceMediaType('text/html'), false);
  assert.equal(isWorkspaceMediaType('image/svg+xml'), false);
});
