# Agent Session Tower

[한국어](README.ko.md)

**Keep using your Claude Code and Codex harnesses. Monitor and manage your agents at a glance in a web UI.**

Especially useful when running multiple agents across sessions or managing them remotely.

Run one command to see your existing local sessions organized by project on a live node graph:

```sh
npx --yes github:kimwz/agent-session-tower
```

Or clone the repository and run it locally:

```sh
git clone https://github.com/kimwz/agent-session-tower.git
cd agent-session-tower
npm ci
npm start
```

`npm ci` installs dependencies and builds the app automatically.

Your browser opens at **http://localhost:8000** with a canvas like this:

![Claude Code and Codex sessions grouped by project on the Agent Session Tower graph canvas](docs/images/session-graph.png)

Requires **Node.js 22.13+**, **npm**, and **Git**. Use your existing Claude Code or Codex installation and sign-in. The first run downloads and builds the app; later runs reuse npm's cache. Tested on macOS. The web UI supports **English and Korean**.

## What you can do

- **See existing sessions immediately.** Automatically discovers local Claude Code and Codex histories, including sessions started outside Tower.
- **Follow work on a live graph.** View projects, sessions, and subagents together, with working, waiting, completed, and error states.
- **Check account usage.** See Claude Code and Codex usage as small donuts inside the machine node. Hover or focus for usage windows and reset times.
- **Create new sessions.** Choose Claude Code or Codex, pick an existing project folder, and send the first request from the web.
- **Route a prompt automatically.** Open **Auto Prompt** from the sparkle button on a machine or folder. A separate Opus or GPT Sol agent chooses a suitable existing session or starts a new one, and shows its reason.
- **Continue a conversation.** Read the original history and send the next instruction to the same native session. Attach files or paste images.
- **Choose a model in chat.** Keep the agent's default or select a model for your next request.
- **Approve tools in chat.** Tower-launched sessions keep native permission settings and show the requested action or access for approval or denial. Existing Codex desktop sessions handle approvals in their original app.
- **Organize your workspace.** Rename sessions and project groups, pin projects, drag nodes, search, filter, and hide or reopen sessions.
- **Catch new activity.** Unread indicators help you find replies and results you have not opened yet.
- **Access it remotely.** Open the web UI from another device on your LAN or VPN, with password-protected access to the machine running your agents.

No separate Tower account, API key, database, or CLI hooks. Your agents keep using their existing CLI accounts and model settings.

## Remote access

Stop the running Tower with `Ctrl+C`, then start it with:

```sh
npx --yes github:kimwz/agent-session-tower --host 0.0.0.0 --port 8000
```

Open the network address printed in the terminal from your other device. Sign in as `monitor` with the password stored at the printed password-file path. Keep the host machine and Tower running.

Direct access uses HTTP, so use a trusted LAN or VPN. See [remote access details](docs/usage.md#remote-access).

## More

- [Usage, CLI options, and how sessions work](docs/usage.md)
- [Run from source and contribute](docs/development.md)
- [MIT license](LICENSE)
