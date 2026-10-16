import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initDatabase } from '@/data/repository'
import './index.css'

async function bootstrap() {
  // 首次启动写入种子数据（分类树 / 标签 / 食材字典）
  await initDatabase()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  )
}

void bootstrap()
