import { OPERATIONS } from '../../shared/api/operations.js';
import { issueRequest } from '../../shared/issues.js';

/**
 * The routes the owner's pages use, for the model. The master calls exactly these routes, so anything the pages can
 * do it can do; this list only tells it how. `/api/v1` operations are listed from their own definitions.
 */
const ROUTES = `
State
- GET /api/snapshot — everything the canvas shows: sessions (id, provider, cwd, title, status, lastMessage), runs (status, prompt; no output), autoPrompts, groups, repositories, triggers overview, providers.
- GET /api/sessions/{id}?limit=&before= — a conversation's messages (newest last) and the session.
- GET /api/attachments/{id} · GET /api/chat-images/{id} — a file attached to a message, an image shown in a conversation.

Sessions and work
- POST /api/sessions {provider:"claude"|"codex", cwd, prompt, title?, model?, effort?} — start a new session with a first request.
- POST /api/sessions/{id}/messages {prompt, model?, effort?} — send a message to a session (queued if it is working).
- POST /api/sessions/{id}/title {title} · POST /api/sessions/{id}/(close|reopen) {} · POST /api/sessions/{id}/acknowledge {} (mark a finished turn seen)
- POST /api/runs/{runId}/cancel {} — stop a running request. Only when the owner asked to stop it.
- POST /api/runs/{runId}/steer {} — insert a queued message into the running turn now.
- POST /api/runs/{runId}/dismiss {} — hide a failed run.
- POST /api/runs/{runId}/approvals/{approvalId} {decision:"allow"|"deny"} or {answers:{[question]:{answers:[...]}}} or {action:"accept"|"decline"|"cancel", content} — the approval id as the run gives it, URL-encoded.
- POST /api/auto-prompts {requestId(uuid), provider, prompt, cwd?, sessionMode?:"new", targetSessionId?, model?, effort?} — let Tower route a task to the right project/session. GET /api/auto-prompts/{id} · POST /api/auto-prompts/{id}/cancel {}
- Register an issue in a project's repository: POST /api/sessions in that folder with a short title ("이슈 등록: …") and the prompt ${JSON.stringify(issueRequest('<the issue as the owner described it>'))}; the session analyses it and files it.

Folders, git, files, terminals
- POST /api/groups {cwd, title?, pinned?, hidden?} — folder name, pin, hide.
- POST /api/repositories {cwd, action:"refresh"|"pull"|"push"}
- GET /api/workspace/tree?cwd=&path= · GET /api/workspace/file?cwd=&path= · POST /api/workspace/file {cwd, path, content, revision|null} · POST /api/workspace/directory {cwd, path}
- GET /api/workspace/terminals?cwd= · POST /api/workspace/terminals {cwd, cols, rows} · POST /api/workspace/terminals/{id}/input {data} · POST /api/workspace/terminals/{id}/resize {cols, rows} · POST /api/workspace/terminals/{id}/close {} (read a terminal's recent output with terminal_read)

Skills and guidance
- GET /api/skills?cwd= — skills (where each applies, pinned), Tower-kept skills, proposals, notes, settings, and guidance {owner, revision}. GET /api/skills/detail?dir=&cwd= — one skill's files. GET /api/skills/summary — ready proposals.
- POST /api/skills/save {name, description, body, targets:{all:true}|{projects:[cwd]}, pinned?, proposalId?} — a new Tower skill; edit one with {dir, revision, name, description, body, targets?, targetsRevision?}.
- POST /api/skills/pin {dir, pinned, cwd?} · POST /api/skills/assign {dir, targets, targetsRevision?} — the projects a Tower skill applies to.
- POST /api/skills/(link|merge|adopt) {dir, cwd?} — link a skill where it applies, merge duplicate folders, take an outside skill into Tower.
- POST /api/skills/delete {dir, cwd?} · POST /api/skills/dismiss {id} (a proposal) · POST /api/skills/settings {enabled?, provider?} (automatic proposals) · POST /api/skills/backfill {days?}
- POST /api/skills/guidance {owner, revision} — the owner's guidance every agent gets (revision from GET /api/skills).
- POST /api/skills/export {dirs:[dir], guidance?} → the bundle file · POST /api/skills/import-plan <the bundle file itself as the body> → what each skill would do · POST /api/skills/import {bundle, choices:[{index, action:"add"|"replace"}]}

Other computers (joined to this one)
- Any route above for a joined computer: pass node:"<32-hex id>" (it goes to /api/nodes/{node}/...). Their ids are in GET /api/link (nodes).
- GET /api/link — this computer's link: hub, nodes, controllers, exclusions. GET /api/link/changes
- POST /api/link/hub {enabled?, port?} · POST /api/link/invite {} · POST /api/link/join {code} · POST /api/link/nodes/{id} {label} · POST /api/link/nodes/{id}/(update|remove) {} · POST /api/link/controllers/{id}/remove {}
- GET /api/remote/exclusions · POST /api/remote/exclusions {add}|{remove}|{reset:true} · POST /api/nodes/{node}/view {cwd, pinned?, hidden?}

Slack, public agents, notifications, fast judgments
- GET /api/slack · POST /api/slack/(connect|disconnect|settings|rules|tone/collect|tone/save|replies/approve)
- GET /api/public-agents · GET /api/public-agents/conversation?agent=&id= · POST /api/public-agents/(create|update|password|rotate|delete|reset|delete-conversation|listener)
- GET /api/notifications · POST /api/notifications/(update|remove|test) {id,...} · POST /api/notifications/subscribe (needs the owner's browser)
- GET /api/decisions · POST /api/decisions/settings {provider?, apiKey?|null, features?} · POST /api/decisions/test {}
- POST /api/auto-prompt-suggestions {prompt, provider, cwd?, node?} — where Auto Prompt would send a request.

Master agent (not for the master itself)
- GET /api/master · GET /api/master/state · POST /api/master/start {provider, text, model?, effort?, replace?} · POST /api/master/release {} · POST /api/master/settings {...}
- GET /api/master/voice/voices · GET /api/master/voice/timings · POST /api/master/voice/preview {voiceId}

Backup (the owner and their local agents; never the master)
- GET /api/backup · POST /api/backup/settings {remote:{endpoint, bucket, prefix, region?, accessKeyId, secretAccessKey?}, passphrase?, intervalHours, keep, ...} · POST /api/backup/(run|test|remote) {}
- POST /api/backup/export {passphrase} · POST /api/backup/remote/download {key} — the encrypted file. POST /api/backup/restore/check {file, passphrase} → {id} · POST /api/backup/restore/(apply|cancel) {id}

Account and Tower (this computer only)
- GET /api/auth/overview · POST /api/auth/credentials {username, password} · POST /api/auth/unblock {ip}
- POST /api/tower/update {version?} — background-service installs. POST /api/runner/force-update {} — update the execution worker now (running turns wrap up first).
`.trim();

/** Routes whose answer or body is a whole file: an agent sends them with curl (see the local tools' guide), not through a tool result. */
export const FILE_ROUTES: readonly string[] = ['/api/backup/export', '/api/backup/remote/download', '/api/backup/restore/check', '/api/skills/export', '/api/skills/import-plan', '/api/skills/import'];

function operations(): string {
  return Object.entries(OPERATIONS).map(([name, definition]) => `- POST /api/v1/${name} — ${definition.summary}${definition.write ? '' : ' (read)'}`).join('\n');
}

export function apiCatalog(): string {
  return `${ROUTES}\n\nTower operations (the body is exactly the operation's input)\n${operations()}`;
}
