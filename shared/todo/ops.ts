import { z } from 'zod';
import { validDate, validTime } from './dates.js';

/**
 * The changes the Todo page sends. One request carries several operations and applies all of them or none, so an
 * action such as "complete and add the next task" is a list of these, not an operation of its own. Ids of new things
 * come from the page, which lets an operation refer to something an earlier one in the same request creates and makes
 * a retried request harmless.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'An id of letters, digits, - or _ is required.');
const date = z.string().refine(validDate, 'A date (YYYY-MM-DD) is required.');
const time = z.string().refine(validTime, 'A time (HH:mm) is required.');
const name = (max: number) => z.string().trim().min(1).max(max);
const color = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'A color name is required.');
/** Where an item goes among its siblings: after this one, first (null), or last (absent). */
const afterId = id.nullable().optional();

export const RecurrenceSchema = z.object({
  freq: z.enum(['day', 'week', 'month', 'year']),
  interval: z.number().int().min(1).max(999),
  workdays: z.boolean().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  monthDays: z.array(z.number().int().min(-1).max(31).refine(day => day !== 0, 'Day 0 does not exist.')).min(1).max(31).optional(),
  nth: z.object({ n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1)]), weekday: z.number().int().min(0).max(6) }).strict().optional(),
  yearDate: z.tuple([z.number().int().min(1).max(12), z.number().int().min(1).max(31)]).optional(),
  fromCompletion: z.boolean().optional(),
  until: date.optional(),
}).strict()
  .refine(rule => !rule.workdays || rule.freq === 'day', 'Workdays repeat daily.')
  .refine(rule => !rule.weekdays || rule.freq === 'week', 'Weekdays belong to a weekly rule.')
  .refine(rule => (!rule.monthDays && !rule.nth) || rule.freq === 'month', 'Days of the month belong to a monthly rule.')
  .refine(rule => !(rule.monthDays && rule.nth), 'Use days of the month or an nth weekday, not both.')
  .refine(rule => !rule.yearDate || rule.freq === 'year', 'A yearly date belongs to a yearly rule.')
  .refine(rule => !rule.fromCompletion || (!rule.weekdays && !rule.monthDays && !rule.nth && !rule.yearDate), 'Counting from completion repeats by a plain interval.');

const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const taskFields = {
  content: name(500),
  description: z.string().max(16_383),
  priority,
  dueDate: date.nullable(),
  dueTime: time.nullable(),
  recurrence: RecurrenceSchema.nullable(),
  durationMin: z.number().int().min(1).max(1440).nullable(),
  deadlineDate: date.nullable(),
  labelIds: z.array(id).max(100),
};

export const TodoOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('task.create'), id, projectId: id.optional(), sectionId: id.nullable().optional(), parentId: id.nullable().optional(), afterId,
    content: taskFields.content, description: taskFields.description.optional(), priority: priority.optional(), dueDate: taskFields.dueDate.optional(),
    dueTime: taskFields.dueTime.optional(), recurrence: taskFields.recurrence.optional(), durationMin: taskFields.durationMin.optional(),
    deadlineDate: taskFields.deadlineDate.optional(), labelIds: taskFields.labelIds.optional() }).strict(),
  z.object({ op: z.literal('task.update'), id, patch: z.object(taskFields).partial().strict().refine(patch => Object.keys(patch).length > 0, 'Nothing to change.') }).strict(),
  z.object({ op: z.literal('task.move'), id, projectId: id.optional(), sectionId: id.nullable().optional(), parentId: id.nullable().optional(), afterId }).strict(),
  /** `occurrence` is the date being done (the task's current date, or null): a repeating occurrence is done once. `today` is the page's local date. */
  z.object({ op: z.literal('task.complete'), id, completionId: id, occurrence: date.nullable(), today: date }).strict(),
  z.object({ op: z.literal('task.uncomplete'), id, completionId: id }).strict(),
  z.object({ op: z.literal('task.delete'), id }).strict(),
  z.object({ op: z.literal('task.restore'), id }).strict(),
  z.object({ op: z.literal('link.create'), id, fromTaskId: id, toTaskId: id }).strict(),
  z.object({ op: z.literal('link.delete'), id }).strict(),
  z.object({ op: z.literal('project.create'), id, name: name(120), parentId: id.nullable().optional(), color: color.optional(), afterId }).strict(),
  z.object({ op: z.literal('project.update'), id, patch: z.object({ name: name(120), color, favorite: z.boolean(), layout: z.enum(['board', 'calendar']), archived: z.boolean() }).partial().strict() }).strict(),
  z.object({ op: z.literal('project.move'), id, parentId: id.nullable().optional(), afterId }).strict(),
  z.object({ op: z.literal('project.delete'), id }).strict(),
  z.object({ op: z.literal('project.restore'), id }).strict(),
  z.object({ op: z.literal('section.create'), id, projectId: id, name: name(120), afterId }).strict(),
  z.object({ op: z.literal('section.update'), id, patch: z.object({ name: name(120), collapsed: z.boolean(), archived: z.boolean() }).partial().strict() }).strict(),
  z.object({ op: z.literal('section.move'), id, afterId }).strict(),
  z.object({ op: z.literal('section.delete'), id }).strict(),
  z.object({ op: z.literal('section.restore'), id }).strict(),
  z.object({ op: z.literal('label.create'), id, name: name(60).refine(value => !/[\s#@%/]/.test(value), 'A label name has no spaces or # @ % /.'), color: color.optional() }).strict(),
  z.object({ op: z.literal('label.update'), id, patch: z.object({ name: name(60).refine(value => !/[\s#@%/]/.test(value), 'A label name has no spaces or # @ % /.'), color, favorite: z.boolean() }).partial().strict() }).strict(),
  z.object({ op: z.literal('label.move'), id, afterId }).strict(),
  z.object({ op: z.literal('label.delete'), id }).strict(),
  z.object({ op: z.literal('label.restore'), id }).strict(),
  z.object({ op: z.literal('comment.create'), id, taskId: id, body: z.string().trim().min(1).max(15_000) }).strict(),
  z.object({ op: z.literal('comment.update'), id, body: z.string().trim().min(1).max(15_000) }).strict(),
  z.object({ op: z.literal('comment.delete'), id }).strict(),
  z.object({ op: z.literal('comment.restore'), id }).strict(),
]);

export type TodoOp = z.infer<typeof TodoOpSchema>;
export type TodoOpName = TodoOp['op'];
export type TodoOpOf<N extends TodoOpName> = Extract<TodoOp, { op: N }>;

export const MAX_TODO_OPS = 100;
export const TodoRequestSchema = z.object({
  /** Names the request: sending it again returns the first answer instead of applying it twice. */
  requestId: z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i, 'A request UUID is required.'),
  ops: z.array(TodoOpSchema).min(1).max(MAX_TODO_OPS),
}).strict();
export type TodoRequest = z.infer<typeof TodoRequestSchema>;
