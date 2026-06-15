import '@fontsource-variable/inter'
import './styles/fonts.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import ToastApp from './ToastApp'
import { I18nProvider } from './i18n/I18nContext'
import './styles/base.css'
import './styles/ui.css'

// The notification window loads the same bundle with #toast and renders only
// the toasts on a transparent background.
const isToast = window.location.hash === '#toast'

if (isToast) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}

createRoot(document.getElementById('root')).render(
  <I18nProvider>{isToast ? <ToastApp /> : <App />}</I18nProvider>
)
