import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/cascade';
import { App } from './app/App';
import { registerServiceWorker } from './notifications/push';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
registerServiceWorker();
