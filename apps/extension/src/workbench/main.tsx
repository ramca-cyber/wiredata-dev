import React from 'react';
import ReactDOM from 'react-dom/client';
import { WorkbenchApp } from './WorkbenchApp.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchApp hostMode="fulltab" />
  </React.StrictMode>
);
