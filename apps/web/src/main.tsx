import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { setAuthToken } from './lib/apiClient.ts';
import './styles/index.css';

declare global {
  interface Window {
    __REVIEW_TOKEN__?: string;
  }
}

// SPEC §3: "the web app gets it at page load". The placeholder survives only
// if neither the server nor the dev-server plugin substituted a real token.
const injected = window.__REVIEW_TOKEN__;
if (injected !== undefined && injected !== '__REVIEW_TOKEN_PLACEHOLDER__') {
  setAuthToken(injected);
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root element missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
