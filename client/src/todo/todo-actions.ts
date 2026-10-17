import { completeOp } from '../../../shared/todo/compose';
import type { TodoOp } from '../../../shared/todo/ops';
import type { TodoPriority, TodoTask } from '../../../shared/todo/types';
import { translate as t } from '../i18n/i18n';
import { dateLabel } from './todo-format';
import { isOpen } from './todo-model';
import type { TodoClient } from './todo-store';

/**
 * The page's actions as operations. Each call is one request, so a compound action ("complete and add the next")
 * applies whole or not at all; the toast after a completion offers undo and the task that comes next.
 */

export { completeOp, createTaskOps, quickAddOps, type FollowUp, type QuickAddDraft } from '../../../shared/todo/compose';

export interface ActionHost {
  openTask: (id: string) => void;
}

export function createActions(client: TodoClient, host: ActionHost) {
  const world = () => client.getState().world;
  const nextOpen = (id: string) => Object.values(world().links).filter(link => link.fromTaskId === id).map(link => world().tasks[link.toTaskId]).filter(isOpen) as TodoTask[];
  return {
    complete(task: TodoTask) {
      const following = nextOpen(task.id);
      if (!client.apply([completeOp(task, client.today())])) return;
      const repeat = task.recurrence ? world().tasks[task.id]?.dueDate : null;
      client.toast(repeat && !world().tasks[task.id]?.completedAt ? t('완료했습니다. 다음 반복: {0}', { 0: dateLabel(repeat, client.today()) }) : t('“{0}” 완료', { 0: task.content }), 'info', [
        ...client.undoActions(),
        ...(following[0] ? [{ label: t('다음: {0}', { 0: following[0].content }), run: () => host.openTask(following[0].id) }] : []),
      ]);
    },
    /**
     * Reopens a completion: the one given (a row of the completed list), else the task's latest, read fresh so another
     * page's later completion is the one undone. The server refuses one that is no longer the latest, and says so.
     */
    async reopen(task: TodoTask, completionId?: string) {
      let id = completionId;
      if (!id) {
        try { id = (await client.detailOf(task.id)).completions[0]?.id; } catch (error) { client.toast(error instanceof Error ? error.message : String(error), 'error'); return; }
      }
      if (!id) { client.toast(t('완료 기록을 찾지 못했습니다.'), 'error'); return; }
      client.apply([{ op: 'task.uncomplete', id: task.id, completionId: id }]);
    },
    remove(task: TodoTask) {
      if (client.apply([{ op: 'task.delete', id: task.id }])) client.toast(t('“{0}” 삭제', { 0: task.content }), 'info', client.undoActions());
    },
    priority(task: TodoTask, priority: TodoPriority) { if (task.priority !== priority) client.apply([{ op: 'task.update', id: task.id, patch: { priority } }]); },
    date(task: TodoTask, dueDate: string | null) { if (task.dueDate !== dueDate) client.apply([{ op: 'task.update', id: task.id, patch: { dueDate } }]); },
    update(task: TodoTask, patch: Extract<TodoOp, { op: 'task.update' }>['patch']) { client.apply([{ op: 'task.update', id: task.id, patch }]); },
  };
}
export type TodoActions = ReturnType<typeof createActions>;
