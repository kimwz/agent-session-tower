import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './session-title.css';
import './session-family.css';
import './workspace-controls.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
