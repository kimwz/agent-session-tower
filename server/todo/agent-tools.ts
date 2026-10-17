import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { completeOp, createTaskOps, quickAddOps, type QuickAddDraft } from '../../shared/todo/compose.js';
import { addDays, formatDate } from '../../shared/todo/dates.js';
import { TodoOpSchema, TodoRequestSchema, type TodoOp } from '../../shared/todo/ops.js';
import { parseQuickAdd, type QuickAddResult } from '../../shared/todo/quick-add.js';
import type { TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../shared/todo/types.js';
import { TowerError } from '../../shared/errors.js';

/**
 * The Todo tools every agent Tower runs gets (server `tower_todos`, owner's order of 2026-10-17: reading and changing
 * todos is open to all of them, outside input included). They work on this computer's todos through the same store
 * calls as the page, so a change an agent makes is checked, applied whole and shown on the page at once.
 *
 * Each tool is one entry of `TOOLS`: a name, what it is for, its input and what it does. A new tool is a new entry.
 */

export const TODO_TOOLS_SERVER = 'tower_todos';
/** Where the web answers them (see todo/agent-mcp.ts). */
export const TODO_TOOLS_PATH = '/api/todos/agent';

/** What the tools need of the store: the web's own todo calls, whose `apply` also tells the pages. */
export interface TodoToolStore {
  overview(): TodoOverview;
  detail(id: string): TodoTaskDetail;
  completed(input: { projectId?: string; before?: string; limit?: number }): TodoCompletedPage;
  search(query: string, input: { completed?: boolean; limit?: number }): TodoTask[];
  apply(request: z.infer<typeof TodoRequestSchema>): TodoChanges;
}

interface Context { store: TodoToolStore; today: string; newId: () => string }
interface Tool<T extends z.ZodType = z.ZodType> { name: string; description: string; input: T; run(args: z.infer<T>, context: Context): unknown }
const tool = <T extends z.ZodType>(definition: Tool<T>): Tool => definition as unknown as Tool;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'A task, project, section or label id as the tools give it.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:mm');
const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).describe('1 is the highest, 4 (default) none.');
const labels = z.array(z.string().trim().min(1).max(60)).max(20).describe('Label names; ones that do not exist yet are created.');
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const fields = {
  description: z.string().max(16_383).optional().describe('Markdown.'),
  projectId: id.optional(),
  sectionId: id.optional(),
  labels: labels.optional(),
  priority: priority.optional(),
  dueDate: date.optional(),
  dueTime: time.optional().describe('Needs a date (typed or dueDate).'),
  deadlineDate: date.optional(),
  durationMin: z.number().int().min(1).max(1440).optional(),
};
const AddInput = z.object({
  text: z.string().trim().min(1).max(1000).describe('The task in words. Recognized and taken out of the title: #project, /section, @label, p1–p4, {deadline}, dates and times (내일 오후 3시, 10월 20일, next fri 15:00), durations (1시간, 30m) and repeats (매일, 평일, 매주 월,수, 매월 15일, 3일마다, 완료 후 3일마다, every week).'),
  parse: z.boolean().optional().describe('false keeps text as the title, word for word.'),
  ...fields,
  parentId: id.optional().describe('Adds it as a sub-task of this task.'),
}).strict();
const NextInput = AddInput;

/** Comments a task's detail carries (the latest); together they stay well under what a tool answer may hold. */
const MAX_COMMENTS = 50;
const DAY = (now: Date) => formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate());

/** Names instead of ids, and only what a task has: what an agent reads. */
function namer(overview: Pick<TodoOverview, 'projects' | 'sections' | 'labels' | 'links' | 'tasks'>) {
  const projects = new Map(overview.projects.map(project => [project.id, project.inbox ? 'Inbox' : project.name]));
  const sections = new Map(overview.sections.map(section => [section.id, section.name]));
  const labelNames = new Map(overview.labels.map(label => [label.id, label.name]));
  const next = new Map<string, string[]>();
  for (const link of overview.links) next.set(link.fromTaskId, [...(next.get(link.fromTaskId) ?? []), link.toTaskId]);
  return (task: TodoTask, full = false) => {
    const description = full || task.description.length <= 200 ? task.description : `${task.description.slice(0, 200)}…`;
    const followers = next.get(task.id);
    return {
      id: task.id, content: task.content,
      project: projects.get(task.projectId) ?? task.projectId, projectId: task.projectId,
      ...(task.sectionId ? { section: sections.get(task.sectionId) ?? task.sectionId, sectionId: task.sectionId } : {}),
      ...(task.parentId ? { parentId: task.parentId } : {}),
      ...(task.dueDate ? { due: task.dueTime ? `${task.dueDate} ${task.dueTime}` : task.dueDate } : {}),
      ...(task.recurrence ? { recurrence: task.recurrence } : {}),
      ...(task.deadlineDate ? { deadline: task.deadlineDate } : {}),
      ...(task.durationMin ? { durationMin: task.durationMin } : {}),
      ...(task.priority !== 4 ? { priority: task.priority } : {}),
      ...(task.labelIds.length ? { labels: task.labelIds.map(label => labelNames.get(label) ?? label) } : {}),
      ...(description ? { description } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(followers?.length ? { next: followers } : {}),
    };
  };
}

/** Dated first (by date, then time), then by priority and the list's own order. */
const byWhen = (a: TodoTask, b: TodoTask) => (a.dueDate ?? '9999') .localeCompare(b.dueDate ?? '9999') || (a.dueTime ?? '99').localeCompare(b.dueTime ?? '99')
  || a.priority - b.priority || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);

function task(overview: TodoOverview, store: TodoToolStore, taskId: string): TodoTask {
  // The overview holds open tasks; a completed one is read on its own.
  return overview.tasks.find(item => item.id === taskId) ?? store.detail(taskId).task;
}

function apply(context: Context, ops: TodoOp[]): TodoChanges {
  const request = TodoRequestSchema.safeParse({ requestId: context.newId(), ops });
  if (!request.success) throw new TowerError('invalid', request.error.issues.map(issue => `${issue.path.join('.') || 'ops'}: ${issue.message}`).join('; '));
  return context.store.apply(request.data);
}

/** Label names as ids, with label.create operations for the new ones (to go first in the same request). */
function labelIds(overview: TodoOverview, names: readonly string[], newId: () => string): { ids: string[]; ops: TodoOp[] } {
  const known = new Map(overview.labels.map(label => [label.name.toLocaleLowerCase(), label.id]));
  const ops: TodoOp[] = [];
  for (const name of names) {
    if (known.has(name.toLocaleLowerCase())) continue;
    const made = { op: 'label.create' as const, id: newId(), name };
    ops.push(made); known.set(name.toLocaleLowerCase(), made.id);
  }
  return { ids: [...new Set(names.map(name => known.get(name.toLocaleLowerCase())!))], ops };
}

/** A task added in words, as Quick Add reads them; explicit fields win over what the words say. */
function draftOf(overview: TodoOverview, input: z.infer<typeof AddInput>, today: string, newId: () => string): { draft: QuickAddDraft; labelOps: TodoOp[] } {
  const projects = overview.projects.filter(project => !project.archivedAt).flatMap(project => project.inbox ? [{ id: project.id, name: '관리함' }, { id: project.id, name: 'Inbox' }] : [{ id: project.id, name: project.name }]);
  const sections = overview.sections.filter(section => !section.archivedAt);
  const section = input.sectionId ? sections.find(item => item.id === input.sectionId) : undefined;
  if (input.sectionId && !section) throw new TowerError('not-found', `Section ${input.sectionId} not found (todos_overview lists them).`);
  const explicitProject = input.projectId ?? section?.projectId;
  const parsed: QuickAddResult = input.parse === false ? { content: input.text, tokens: [], labelIds: [], newLabels: [] }
    : parseQuickAdd(input.text, { today, projects, sections, labels: overview.labels, ...(explicitProject ? { defaultProjectId: explicitProject } : {}) });
  const content = parsed.content.trim();
  if (!content) throw new TowerError('invalid', 'The task has no title once the recognized words are taken out; pass parse: false to keep the text as it is.');
  if (content.length > 500) throw new TowerError('invalid', 'A task title is at most 500 characters; put the rest in description.');
  if (input.dueTime && !(input.dueDate ?? parsed.dueDate)) throw new TowerError('invalid', 'dueTime needs a date: give dueDate, or a date in the text.');
  const named = input.labels ? labelIds(overview, input.labels, newId) : { ids: [], ops: [] };
  const projectId = explicitProject ?? parsed.projectId;
  const sectionId = input.sectionId ?? (input.projectId && input.projectId !== parsed.projectId ? undefined : parsed.sectionId);
  return {
    labelOps: named.ops,
    draft: {
      content, description: input.description ?? '',
      result: {
        ...(projectId ? { projectId } : {}), ...(sectionId ? { sectionId } : {}),
        labelIds: [...new Set([...parsed.labelIds, ...named.ids])], newLabels: parsed.newLabels.filter(name => !input.labels?.some(label => label.toLocaleLowerCase() === name.toLocaleLowerCase())),
        priority: input.priority ?? parsed.priority,
        dueDate: input.dueDate ?? parsed.dueDate, dueTime: input.dueTime ?? parsed.dueTime, recurrence: parsed.recurrence,
        durationMin: input.durationMin ?? parsed.durationMin, deadlineDate: input.deadlineDate ?? parsed.deadlineDate,
      },
    },
  };
}

/** Adds a task in one request: alone, as a sub-task, or after `after` (completing it first when `complete`). */
function add(context: Context, input: z.infer<typeof AddInput>, follow?: { after: TodoTask; complete: boolean }) {
  const overview = context.store.overview();
  const { draft, labelOps } = draftOf(overview, input, context.today, context.newId);
  const { ops, id: created } = quickAddOps(draft, follow ? { taskId: follow.after.id, complete: follow.complete } : null, follow?.after, context.today,
    input.parentId ? { parentId: input.parentId } : {}, context.newId);
  const changes = apply(context, [...labelOps, ...ops]);
  const after = context.store.overview();
  const name = namer(after);
  const made = changes.tasks.find(item => item.id === created);
  const done = follow && changes.tasks.find(item => item.id === follow.after.id);
  return { added: made ? name(made) : { id: created }, ...(done ? { completed: name(done) } : {}) };
}

const TOOLS: Tool[] = [
  tool({
    name: 'todos_overview', input: z.object({}).strict(),
    description: 'The todo lists on this computer: projects (Inbox first), sections, labels, how many tasks are overdue, due today and in the Inbox, and today\'s date. Read it for the ids the other tools take.',
    run: (_, { store, today }) => {
      const overview = store.overview();
      const inbox = overview.projects.find(project => project.inbox);
      return {
        today, ...(overview.availability.state === 'read-only' ? { readOnly: overview.availability.reason } : {}),
        counts: { open: overview.tasks.length, overdue: overview.tasks.filter(item => item.dueDate && item.dueDate < today).length,
          today: overview.tasks.filter(item => item.dueDate === today).length, inbox: overview.tasks.filter(item => item.projectId === inbox?.id).length },
        projects: overview.projects.map(project => ({ id: project.id, name: project.inbox ? 'Inbox' : project.name, ...(project.parentId ? { parentId: project.parentId } : {}),
          ...(project.inbox ? { inbox: true } : {}), ...(project.archivedAt ? { archived: true } : {}), ...(project.favorite ? { favorite: true } : {}) })),
        sections: overview.sections.filter(section => !section.archivedAt).map(section => ({ id: section.id, projectId: section.projectId, name: section.name })),
        labels: overview.labels.map(label => ({ id: label.id, name: label.name })),
      };
    },
  }),
  tool({
    name: 'todos_list',
    description: 'Open tasks of one list: today (overdue and due today), upcoming (from today on, for `days` days), inbox, a project, a label, or all; by date, then priority.',
    input: z.object({ view: z.enum(['today', 'upcoming', 'inbox', 'project', 'label', 'all']), projectId: id.optional(), labelId: id.optional(),
      days: z.number().int().min(1).max(60).optional().describe('For upcoming; 7 by default.'), limit: limit(200).describe('50 by default.') }).strict(),
    run: ({ view, projectId, labelId, days, limit: count }, { store, today }) => {
      const overview = store.overview();
      const inbox = overview.projects.find(project => project.inbox)?.id;
      if (view === 'project' && !projectId) throw new TowerError('invalid', 'view "project" needs projectId.');
      if (view === 'label' && !labelId) throw new TowerError('invalid', 'view "label" needs labelId.');
      const end = addDays(today, days ?? 7);
      const shown = overview.tasks.filter(item => view === 'all' ? true
        : view === 'today' ? !!item.dueDate && item.dueDate <= today
        : view === 'upcoming' ? !!item.dueDate && item.dueDate >= today && item.dueDate < end
        : view === 'inbox' ? item.projectId === inbox
        : view === 'project' ? item.projectId === projectId
        : item.labelIds.includes(labelId!)).sort(byWhen);
      const name = namer(overview);
      return { today, view, total: shown.length, tasks: shown.slice(0, count ?? 50).map(item => name(item)) };
    },
  }),
  tool({
    name: 'todos_search', description: 'Tasks whose title or description contains the words, open ones (or completed ones too with completed: true).',
    input: z.object({ query: z.string().trim().min(1).max(200), completed: z.boolean().optional(), limit: limit(100) }).strict(),
    run: ({ query, completed, limit: count }, { store }) => {
      const name = namer(store.overview());
      return { tasks: store.search(query, { completed, limit: count ?? 30 }).map(item => name(item)) };
    },
  }),
  tool({
    name: 'todos_get', description: 'One task in full: its description, sub-tasks, comments, attachments (names and sizes), completions, and the tasks before and after it.',
    input: z.object({ id }).strict(),
    run: ({ id: taskId }, { store }) => {
      const detail = store.detail(taskId);
      const overview = store.overview();
      const links = new Map([...overview.links, ...detail.next.map(item => item.link)].map(link => [link.id, link]));
      const name = namer({ ...overview, links: [...links.values()] });
      const comments = detail.comments.filter(comment => !comment.deletedAt);
      return {
        task: name(detail.task, true),
        subtasks: detail.subtasks.map(item => name(item)),
        // The latest comments, so a long discussion still fits one answer.
        comments: comments.slice(-MAX_COMMENTS).map(comment => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt })),
        ...(comments.length > MAX_COMMENTS ? { olderComments: comments.length - MAX_COMMENTS } : {}),
        files: detail.files.map(file => ({ id: file.id, name: file.name, size: file.size, ...(file.commentId ? { commentId: file.commentId } : {}) })),
        completions: detail.completions.map(item => ({ id: item.id, completedAt: item.completedAt, ...(item.occurrenceDate ? { date: item.occurrenceDate } : {}) })),
        previous: detail.previous.map(item => ({ linkId: item.link.id, task: name(item.task) })),
        next: detail.next.map(item => ({ linkId: item.link.id, task: name(item.task) })),
      };
    },
  }),
  tool({
    name: 'todos_completed', description: 'Completed tasks, latest first, of one project or all. Pass the answer\'s before for the next page.',
    input: z.object({ projectId: id.optional(), before: z.string().max(60).optional(), limit: limit(100) }).strict(),
    run: ({ projectId, before, limit: count }, { store }) => {
      const page = store.completed({ projectId, before, limit: count ?? 30 });
      const name = namer(store.overview());
      return { items: page.items.map(item => ({ completionId: item.completion.id, completedAt: item.completion.completedAt, task: name(item.task) })), ...(page.before ? { before: page.before } : {}) };
    },
  }),
  tool({
    name: 'todos_add',
    description: 'Adds a task, written as the owner would type it in Quick Add (e.g. "견적 회신 내일 오후 3시 #타워 p1"). With after, it comes after that task as its next step (order only: either can be done first); completeAfter also completes that task in the same request.',
    input: AddInput.extend({ after: id.optional().describe('The task this one comes after.'), completeAfter: z.boolean().optional() }).strict(),
    run: ({ after, completeAfter, ...input }, context) => {
      if (completeAfter && !after) throw new TowerError('invalid', 'completeAfter needs after.');
      return add(context, input, after ? { after: task(context.store.overview(), context.store, after), complete: !!completeAfter } : undefined);
    },
  }),
  tool({
    name: 'todos_complete',
    description: 'Completes a task (a repeating one moves on to its next date). With next, adds the task that comes after it in the same request ("complete and add next").',
    input: z.object({ id, next: NextInput.optional() }).strict(),
    run: ({ id: taskId, next }, context) => {
      const current = task(context.store.overview(), context.store, taskId);
      if (current.completedAt) throw new TowerError('conflict', 'This task is already completed.');
      if (next) return add(context, next, { after: current, complete: true });
      const changes = apply(context, [completeOp(current, context.today, context.newId)]);
      const name = namer(context.store.overview());
      const done = changes.tasks.find(item => item.id === taskId);
      return { completed: done ? name(done) : { id: taskId } };
    },
  }),
  tool({
    name: 'todos_reopen', description: 'Takes back a task\'s latest completion.', input: z.object({ id }).strict(),
    run: ({ id: taskId }, context) => {
      const latest = context.store.detail(taskId).completions[0];
      if (!latest) throw new TowerError('not-found', 'This task has no completion to take back.');
      const changes = apply(context, [{ op: 'task.uncomplete', id: taskId, completionId: latest.id }]);
      const reopened = changes.tasks.find(item => item.id === taskId);
      return { reopened: reopened ? namer(context.store.overview())(reopened) : { id: taskId } };
    },
  }),
  tool({
    name: 'todos_update',
    description: 'Changes a task: any of its fields, and where it is (project, section, parent). null clears a field. recurrence takes words as Quick Add reads them (매주 월, every 2 weeks, 완료 후 3일마다).',
    input: z.object({
      id, content: z.string().trim().min(1).max(500).optional(), description: z.string().max(16_383).optional(),
      dueDate: date.nullable().optional(), dueTime: time.nullable().optional(), recurrence: z.string().trim().min(1).max(200).nullable().optional(),
      priority: priority.optional(), labels: labels.optional().describe('All of its labels, by name; [] removes them.'), deadlineDate: date.nullable().optional(),
      durationMin: z.number().int().min(1).max(1440).nullable().optional(),
      projectId: id.optional(), sectionId: id.nullable().optional(), parentId: id.nullable().optional(),
    }).strict(),
    run: ({ id: taskId, projectId, sectionId, parentId, labels: names, recurrence, ...rest }, context) => {
      const overview = context.store.overview();
      const current = task(overview, context.store, taskId);
      const ops: TodoOp[] = [];
      const patch: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
      if (names) { const named = labelIds(overview, names, context.newId); ops.push(...named.ops); patch.labelIds = named.ids; }
      if (recurrence === null) patch.recurrence = null;
      else if (recurrence !== undefined) {
        const parsed = parseQuickAdd(recurrence, { today: context.today, projects: [], sections: [], labels: [] });
        if (!parsed.recurrence) throw new TowerError('invalid', `"${recurrence}" was not read as a repeat (e.g. 매일, 매주 월,수, every 2 weeks, 완료 후 3일마다).`);
        patch.recurrence = parsed.recurrence;
        // A repeat needs a date: its first one, unless the task has a date or one is given.
        if (!current.dueDate && rest.dueDate === undefined && parsed.dueDate) patch.dueDate = parsed.dueDate;
      }
      const move = projectId !== undefined || sectionId !== undefined || parentId !== undefined;
      if (Object.keys(patch).length) ops.push({ op: 'task.update', id: taskId, patch } as TodoOp);
      if (move) ops.push({ op: 'task.move', id: taskId, ...(projectId !== undefined ? { projectId } : {}), ...(sectionId !== undefined ? { sectionId } : {}), ...(parentId !== undefined ? { parentId } : {}) });
      if (!ops.length) throw new TowerError('invalid', 'Nothing to change.');
      const changes = apply(context, ops);
      const changed = changes.tasks.find(item => item.id === taskId);
      return { updated: changed ? namer(context.store.overview())(changed) : { id: taskId } };
    },
  }),
  tool({
    name: 'todos_comment', description: 'Adds a comment (Markdown) to a task.', input: z.object({ id, body: z.string().trim().min(1).max(15_000) }).strict(),
    run: ({ id: taskId, body }, context) => {
      const commentId = context.newId();
      apply(context, [{ op: 'comment.create', id: commentId, taskId, body }]);
      return { commented: { id: commentId, taskId } };
    },
  }),
  tool({
    name: 'todos_delete', description: 'Deletes a task with its sub-tasks. It is kept for 30 days: todos_apply with {op:"task.restore", id} brings it back.',
    input: z.object({ id }).strict(),
    run: ({ id: taskId }, context) => { apply(context, [{ op: 'task.delete', id: taskId }]); return { deleted: { id: taskId } }; },
  }),
  tool({
    name: 'todos_apply',
    description: 'Any other change, as the Todo page makes them, applied together or not at all (up to 100): projects, sections and labels (create, update, move, delete, restore), links between tasks (link.create / link.delete), moving and restoring tasks, editing or deleting comments, deleting or restoring attachments. New items take ids you choose (letters, digits, - or _). Ops: task.create, task.update, task.move, task.complete, task.uncomplete, task.delete, task.restore, link.create, link.delete, project.create, project.update, project.move, project.delete, project.restore, section.create, section.update, section.move, section.delete, section.restore, label.create, label.update, label.move, label.delete, label.restore, comment.create, comment.update, comment.delete, comment.restore, file.delete, file.restore.',
    input: z.object({ ops: z.array(TodoOpSchema).min(1).max(100) }).strict(),
    run: ({ ops }, context) => {
      const changes = apply(context, ops);
      return { revision: changes.revision, changed: { projects: changes.projects.length, sections: changes.sections.length, labels: changes.labels.length, tasks: changes.tasks.length, links: changes.links.length, comments: changes.comments.length } };
    },
  }),
];

/** A store whose overview says why it cannot be read is an error, never an empty list. */
function readable(store: TodoToolStore): TodoToolStore {
  return { ...store, overview: () => {
    const overview = store.overview();
    if (overview.availability.state === 'unavailable') throw new TowerError('unavailable', `The todos cannot be read now: ${overview.availability.reason}`);
    return overview;
  } };
}

/** The tools as MCP lists them. */
export function todoToolList(): unknown[] {
  return TOOLS.map(item => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(item.input, { io: 'input' }) as Record<string, unknown>;
    return { name: item.name, description: item.description, inputSchema };
  });
}

/** Runs one tool; an input that does not fit, or a change the store refuses, is an error with the reason. */
export function callTodoTool(store: TodoToolStore, name: string, args: unknown, options: { now?: Date; newId?: () => string } = {}): unknown {
  const found = TOOLS.find(item => item.name === name);
  if (!found) throw new TowerError('not-found', `Unknown todo tool: ${name}.`);
  const parsed = found.input.safeParse(args ?? {});
  if (!parsed.success) throw new TowerError('invalid', `Invalid input: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`);
  return found.run(parsed.data, { store: readable(store), today: DAY(options.now ?? new Date()), newId: options.newId ?? randomUUID });
}

/** Tool names, for the providers' approval lists. */
export const TODO_TOOL_NAMES: readonly string[] = TOOLS.map(item => item.name);
