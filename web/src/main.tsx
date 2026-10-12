import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { KeyGate } from './components/KeyGate';
import './styles/globals.css';
import { startTheme } from './lib/theme';

// Before the first paint, so a light theme never flashes dark.
startTheme();

const root = document.getElementById('root');
if (!root) {
  throw new Error('somora-web: #root not found in index.html');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <KeyGate>
      <App />
    </KeyGate>
  </React.StrictMode>,
);
