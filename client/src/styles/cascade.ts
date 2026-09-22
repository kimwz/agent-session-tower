// The import order below is the cascade: later sheets override earlier ones at equal specificity.
// Components never import CSS themselves, so they stay renderable under node:test.
import './project-groups.css';
import './manual-graph.css';
import './auto-prompt.css';
import './provider-usage.css';
import './new-session.css';
import '@xyflow/react/dist/style.css';
import './base.css';
import './app-shell.css';
import './sidebar.css';
import './canvas.css';
import './graph-nodes.css';
import './canvas-states.css';
import './chat.css';
import './run-controls.css';
import './composer.css';
import './animations.css';
import './responsive.css';
import './reduced-motion.css';
import './session-title.css';
import './session-family.css';
import './workspace-controls.css';
import './chat-layout.css';

import '@xterm/xterm/css/xterm.css';
import './workspace-page.css';

import "./auth.css";

import './slack.css';
import './slack-canvas.css';
import './slack-monitor.css';
