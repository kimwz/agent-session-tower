import test from 'node:test';
import assert from 'node:assert/strict';
import { isTaskNotification, taskNotice } from '../../shared/task-notification.js';

test('a background task notice keeps its status, summary and report, and leaves out paths, ids and the agent’s instruction', () => {
  const raw = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/private/tmp/b1.output</output-file>\n<status>completed</status>\n'
    + '<summary>Agent "Review" finished</summary>\n<result>Two findings.</result>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>';
  assert.equal(isTaskNotification(`  ${raw}`), true);
  assert.equal(isTaskNotification('Please explain <task-notification> tags'), false);
  assert.deepEqual(taskNotice(raw), { text: '**completed** · Agent "Review" finished\n\nTwo findings.', failed: false });
  assert.equal(taskNotice('<task-notification><status>killed</status></task-notification>').failed, true);
  assert.deepEqual(taskNotice('<task-notification>\nPlain words\n</task-notification>'), { text: 'Plain words', failed: false });
});
