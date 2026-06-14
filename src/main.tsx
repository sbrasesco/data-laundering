import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';
import { applyTheme, getStoredTheme } from './lib/themes';
import { ErrorBoundary } from './components/ErrorBoundary';

applyTheme(getStoredTheme());

window.addEventListener('unhandledrejection', (event) => {
  console.warn('[unhandledrejection]', event.reason);
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

