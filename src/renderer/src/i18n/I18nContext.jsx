import { createContext, useContext, useEffect, useState } from 'react'
import api from '../lib/api'
import { setDateLocale } from '../lib/dates'
import { translations, DEFAULT_LANG } from './translations'

const LOCALES = { en: 'en-US', uk: 'uk-UA' }

const I18nContext = createContext(null)

function resolve(dict, key) {
  return key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict)
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(DEFAULT_LANG)

  const apply = (next) => {
    setLangState(next)
    setDateLocale(LOCALES[next] || 'en-US')
    document.documentElement.lang = next
  }

  useEffect(() => {
    Promise.resolve(api.getLanguage?.()).then((saved) => {
      if (saved && translations[saved]) apply(saved)
    })
  }, [])

  const setLang = (next) => {
    apply(next)
    api.setLanguage?.(next)
  }

  const t = (key) =>
    resolve(translations[lang], key) ?? resolve(translations[DEFAULT_LANG], key) ?? key

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>
}

// Fallback keeps components from crashing if the context is ever missing
// (e.g. a transient React Fast Refresh desync during development).
const FALLBACK = {
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key) => resolve(translations[DEFAULT_LANG], key) ?? key
}

export function useI18n() {
  return useContext(I18nContext) || FALLBACK
}
