import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { initTheme } from './tt/theme.js'

initTheme();   // 掛載前先套主題，不然深色模式會先閃一下白底
window.__booted = true;   // 告訴 index.html 的白屏救援：程式跑起來了
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
