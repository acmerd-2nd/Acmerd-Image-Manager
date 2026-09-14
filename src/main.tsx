import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/ToastProvider'
import { LocaleProvider } from './i18n'
import { ThemeProvider } from './lib/theme'
import { initMotion } from './lib/motion'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <LocaleProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </LocaleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)

// V1.9.2：装配动效基座（入场揭示引擎）。渲染后再调用，确保能扫到首屏 [data-reveal] 节点。
initMotion()
