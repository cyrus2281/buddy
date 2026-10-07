import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const hash = window.location.hash;
const isHud = hash.startsWith('#/hud');
// The island and the ghost are drawn over other apps on transparent windows,
// so they need the HUD's transparent body for the same reason the HUD does.
const surface = hash.startsWith('#/island') ? 'island' : hash.startsWith('#/ghost') ? 'ghost' : null;
if (isHud || surface) document.body.classList.add('hud');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App hud={isHud} surface={surface} />
  </React.StrictMode>,
);
