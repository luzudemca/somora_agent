import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { KeyGate } from './components/KeyGate';
import './styles/globals.css';

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
