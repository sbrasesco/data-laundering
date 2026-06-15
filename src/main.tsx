import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import App from './App';
import './styles/global.css';
import { applyTheme, getStoredTheme } from './lib/themes';
import { ErrorBoundary } from './components/ErrorBoundary';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION,
  enabled: import.meta.env.PROD,
  tracesSampleRate: 0,
  beforeSend(event) {
    const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
    const isExternal = frames.some(
      (f) =>
        f.filename?.includes('extension://') ||
        f.filename?.includes('chrome-extension://')
    );
    return isExternal ? null : event;
  },
});

applyTheme(getStoredTheme());

window.addEventListener('unhandledrejection', (event) => {
  console.warn('[unhandledrejection]', event.reason);
  const stack = (event.reason as Error)?.stack ?? '';
  if (
    !stack.includes('extension://') &&
    !stack.includes('chrome-extension://')
  ) {
    Sentry.captureException(event.reason);
  }
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
