import { z } from 'zod';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';
import { TowerError } from '../../shared/errors.js';

/** The owner page's secret inputs, read the same way by the web (before it asks a joined computer for anything) and the worker. */
const sessionId = z.string().min(1).max(512);
const nodeId = z.string().min(1).max(256);
/** Canonical folders: the web turns the page's `{ cwd }` keys into these before the worker sees them. */
const folders = z.array(z.object({ hostId: z.string().min(1).max(256), root: z.string().min(1).max(4096) }).strict()).max(100);
export const ownerSharing = z.object({ global: z.boolean(), folders }).strict();
export const ownerSession = z.object({ sessionId, nodeId: nodeId.optional() });
export const ownerConnection = z.object({ sessionId, nodeId: nodeId.optional(), secretIds: z.array(z.string().min(1).max(256)).min(1).max(4096) });
/** `kept`: folders the page sent back as identities, accepted only where the key keeps them already. */
export const ownerSharingChange = z.object({ secretId: z.string().min(1).max(256), revision: z.number().int().min(0), kept: folders.optional() }).extend(ownerSharing.shape);
/** A saved value (settings, no session), or a chat value connected to one session: temporary unless saved to the vault. */
export const ownerCreate = z.object({
  name: z.string().trim().min(1).max(256), kind: z.enum(['scalar', 'env', 'file']), value: z.string().optional(), content: z.string().optional(),
  sharing: ownerSharing.optional(), sessionId: sessionId.optional(), nodeId: nodeId.optional(), connect: z.literal('session').optional(), temporary: z.boolean().optional(),
}).refine(input => (input.sessionId === undefined) === (input.connect === undefined) && (input.sessionId !== undefined || (input.nodeId === undefined && !input.temporary))
  // A value kept only with its session is never shared; refused before a task starts for it.
  && !(input.temporary && input.sharing && (input.sharing.global || input.sharing.folders.length)));
export const secretUsage = z.object({
  at: z.number().int().nonnegative(), secretId: z.string().min(1).max(256), name: z.string().max(256), operation: z.enum(SECRET_OPERATIONS),
  outcome: z.enum(['delivered', 'blocked']), review: z.enum(['exempt', 'allowed', 'blocked', 'failed']), reason: z.string().max(2000).optional(),
}).strict();
/** How many recent uses a session view carries. */
export const VIEW_USAGE = 50;

/** The parsed input, or a Korean `invalid` refusal instead of a schema dump. */
export function ownerInput<T extends z.ZodType>(schema: T, input: unknown, message = '시크릿 입력이 올바르지 않습니다.'): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new TowerError('invalid', message);
  return parsed.data;
}
