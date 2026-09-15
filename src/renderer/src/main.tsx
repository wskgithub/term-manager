import ReactDOM from 'react-dom/client'
import App from './App'
import { preapplyTheme } from './theme'
import './index.css'

// React 渲染前先把上次主题写进 <html data-theme>，避免浅色用户首帧闪深色
preapplyTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
