import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const isHud = window.location.hash.startsWith('#/hud');
if (isHud) document.body.classList.add('hud');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App hud={isHud} />
  </React.StrictMode>,
);
