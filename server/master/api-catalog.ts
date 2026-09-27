import { OPERATIONS } from '../../shared/api/operations.js';

/**
 * The routes the owner's pages use, for the model. The master calls exactly these routes, so anything the pages can
 * do it can do; this list only tells it how. `/api/v1` operations are listed from their own definitions.
 */
const ROUTES = `
State
- GET /api/snapshot — everything the canvas shows: sessions (id, provider, cwd, title, status, lastMessage), runs (status, prompt; no output), autoPrompts, groups, repositories, triggers overview, providers.
- GET /api/sessions/{id}?limit=&before= — a conversation's messages (newest last) and the session.

Sessions and work
- POST /api/sessions {provider:"claude"|"codex", cwd, prompt, title?, model?, effort?} — start a new session with a first request.
- POST /api/sessions/{id}/messages {prompt, model?, effort?} — send a message to a session (queued if it is working).
- POST /api/sessions/{id}/title {title} · POST /api/sessions/{id}/close {} · POST /api/sessions/{id}/reopen {}
- POST /api/runs/{runId}/cancel {} — stop a running request. Only when the owner asked to stop it.
- POST /api/runs/{runId}/steer {} — insert a queued message into the running turn now.
- POST /api/runs/{runId}/dismiss {} — hide a failed run.
- POST /api/runs/{runId}/approvals/{approvalId} {decision:"allow"|"deny"} or {answers:{[question]:{answers:[...]}}} or {action:"accept"|"decline"|"cancel", content}
- POST /api/auto-prompts {requestId(uuid), provider, prompt, cwd?, sessionMode?:"new", targetSessionId?, model?, effort?} — let Tower route a task to the right project/session. GET /api/auto-prompts/{id} · POST /api/auto-prompts/{id}/cancel {}

Folders, git, files, terminals
- POST /api/groups {cwd, title?, pinned?, hidden?} — folder name, pin, hide.
- POST /api/repositories {cwd, action:"refresh"|"pull"|"push"}
- GET /api/workspace/tree?cwd=&path= · GET /api/workspace/file?cwd=&path= · POST /api/workspace/file {cwd, path, content, revision|null} · POST /api/workspace/directory {cwd, path}
- GET /api/workspace/terminals?cwd= · POST /api/workspace/terminals {cwd, cols, rows} · POST /api/workspace/terminals/{id}/input {data} · POST /api/workspace/terminals/{id}/close {} (you cannot read a terminal's output)

Other computers (joined to this one)
- Any route above for a joined computer: pass node:"<32-hex id>" (it goes to /api/nodes/{node}/...). Their ids are in GET /api/link (nodes).
- GET /api/link — this computer's link: hub, nodes, controllers, exclusions. GET /api/link/changes
- POST /api/link/hub {enabled?, port?} · POST /api/link/invite {} · POST /api/link/join {code} · POST /api/link/nodes/{id} {label} · POST /api/link/nodes/{id}/update {} · POST /api/link/nodes/{id}/remove {} · POST /api/link/controllers/{id}/remove {}
- GET /api/remote/exclusions · POST /api/remote/exclusions {add}|{remove}|{reset:true} · POST /api/nodes/{node}/view {cwd, pinned?, hidden?}

Slack, public agents, notifications, fast judgments, account, Tower
- GET /api/slack · POST /api/slack/{connect|disconnect|settings|rules|tone/collect|tone/save|replies/approve}
- GET /api/public-agents · GET /api/public-agents/conversation?agent=&id= · POST /api/public-agents/{create|update|password|rotate|delete|reset|delete-conversation|listener}
- GET /api/notifications · POST /api/notifications/{update|remove|test} {id,...} (subscribing needs the owner's browser)
- GET /api/decisions · POST /api/decisions/settings {provider?, apiKey?|null, features?} · POST /api/decisions/test {}
- GET /api/auth/overview · POST /api/auth/credentials {username, password} · POST /api/auth/unblock {ip} — this computer only.
- POST /api/tower/update {version?} — this computer only, background-service installs.
`.trim();

function operations(): string {
  return Object.entries(OPERATIONS).map(([name, definition]) => `- POST /api/v1/${name} — ${definition.summary}${definition.write ? '' : ' (read)'}`).join('\n');
}

export function apiCatalog(): string {
  return `${ROUTES}\n\nTower operations (the body is exactly the operation's input)\n${operations()}`;
}
