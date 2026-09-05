import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/ToastProvider'
import { LocaleProvider } from './i18n'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LocaleProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </LocaleProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
