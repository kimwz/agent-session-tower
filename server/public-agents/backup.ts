/** How a backup's public agents are restored over this computer's (`public-agents.json` and each agent's visitors). */
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { parsePublicAgents } from './service.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function readOptional(path: string): Promise<unknown> {
  try { return await readPrivateJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/**
 * The backup's agents as they are, once each restored agent whose password, address or way of sharing differs from
 * this computer's has signed its visitors out. Undefined when the backup's agents are not valid; errors from signing
 * out are thrown.
 */
export async function restorePublicAgents(stateDir: string, incoming: unknown, existing: unknown): Promise<unknown | undefined> {
  const agents = parsePublicAgents(incoming);
  if (!agents) return undefined;
  await signOutChangedVisitors(stateDir, parsePublicAgents(existing) ?? [], agents);
  return incoming;
}

/**
 * A restored public agent whose password or address differs from this computer's signs its visitors out, as changing
 * them on the page does: a visitor let in under one password is never let in under another.
 */
async function signOutChangedVisitors(stateDir: string, current: { id: string; slug: string; password?: unknown; conversation?: string }[], restored: { id: string; slug: string; password?: unknown; conversation?: string }[]): Promise<void> {
  for (const agent of restored) {
    const before = current.find(item => item.id === agent.id);
    const moved = !before || before.slug !== agent.slug, repassworded = !before || JSON.stringify(before.password) !== JSON.stringify(agent.password);
    const regrouped = !before || before.conversation !== agent.conversation;
    if (!moved && !repassworded && !regrouped) continue;
    const path = join(stateDir, 'public-agents', `${agent.id}.json`);
    const data = await readOptional(path);
    if (!record(data) || !Array.isArray(data.visitors)) continue;
    // Another way of sharing conversations starts each visitor's anew, as it does on the page.
    const visitors = moved ? [] : data.visitors.map(visitor => {
      if (!record(visitor)) return visitor;
      const { conversationId: _conversation, ...rest } = visitor;
      return { ...(regrouped ? rest : visitor), ...(repassworded ? { authorized: false } : {}) };
    });
    await writePrivateJson(path, JSON.stringify({ ...data, visitors }));
  }
}
