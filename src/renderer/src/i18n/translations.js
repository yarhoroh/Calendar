// All interface texts live here. Add a language = add a block with the same
// keys. Date/month names come from Intl (see lib/dates.js), not from here.

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' }
]

export const DEFAULT_LANG = 'en'

export const translations = {
  en: {
    window: {
      minimize: 'Minimize',
      maximize: 'Maximize',
      restore: 'Restore',
      close: 'Close',
      pin: 'Pin on top of all windows',
      unpin: 'Unpin',
      themeLight: 'Light theme',
      themeDark: 'Dark theme'
    },
    nav: { calendar: 'Calendar', settings: 'Settings' },
    close: {
      title: 'Minimize or close?',
      text: 'Calendar can keep running in the tray so you can get back to your notes quickly.',
      remember: 'Remember my choice',
      cancel: 'Cancel',
      quit: 'Close',
      tray: 'Minimize to tray'
    },
    prompt: {
      placeholder: 'Task for the calendar…   Enter — send, Ctrl+Enter — new line',
      send: 'Send',
      stop: 'Stop'
    },
    calendar: { prev: 'Previous', next: 'Next', today: 'Today', pickDate: 'Pick a date', everyday: 'Every day' },
    items: {
      placeholder: 'Write a note…',
      titlePlaceholder: 'Title',
      reminder: 'Reminder',
      clearReminder: 'Clear reminder',
      status: { todo: 'To do', doing: 'In progress', done: 'Done', cancelled: 'Cancelled' }
    },
    settings: {
      tools: 'Local AI tools',
      language: 'Language',
      autostart: 'Launch on startup',
      reminderSound: 'Notification sound',
      showChat: 'Show chat field',
      notifyDuration: { label: 'Notification duration', always: 'Always on', s5: '5 sec', s10: '10 sec' },
      gemini: {
        desc: 'Local AI assistant that will help manage the calendar.',
        checking: 'Checking…',
        active: 'Active',
        missing: 'Not found',
        installing: 'Installing…',
        error: 'Error',
        install: 'Install',
        retry: 'Retry',
        check: 'Check'
      }
    }
  },
  uk: {
    window: {
      minimize: 'Згорнути',
      maximize: 'Розгорнути',
      restore: 'Відновити',
      close: 'Закрити',
      pin: 'Закріпити поверх усіх вікон',
      unpin: 'Відкріпити',
      themeLight: 'Світла тема',
      themeDark: 'Темна тема'
    },
    nav: { calendar: 'Календар', settings: 'Налаштування' },
    close: {
      title: 'Згорнути чи закрити?',
      text: 'Calendar може працювати у треї, щоб швидко повертатися до нотаток.',
      remember: 'Запам’ятати мій вибір',
      cancel: 'Скасувати',
      quit: 'Закрити',
      tray: 'Згорнути в трей'
    },
    prompt: {
      placeholder: 'Завдання календарю…   Enter — надіслати, Ctrl+Enter — новий рядок',
      send: 'Надіслати',
      stop: 'Зупинити'
    },
    calendar: { prev: 'Назад', next: 'Вперед', today: 'Сьогодні', pickDate: 'Обрати дату', everyday: 'Щодня' },
    items: {
      placeholder: 'Напишіть нотатку…',
      titlePlaceholder: 'Заголовок',
      reminder: 'Нагадування',
      clearReminder: 'Прибрати нагадування',
      status: { todo: 'Не виконано', doing: 'В роботі', done: 'Виконано', cancelled: 'Скасовано' }
    },
    settings: {
      tools: 'Локальні AI-інструменти',
      language: 'Мова',
      autostart: 'Запускати під час старту системи',
      reminderSound: 'Звук сповіщення',
      showChat: 'Показувати поле чату',
      notifyDuration: { label: 'Тривалість сповіщення', always: 'Завжди', s5: '5 сек', s10: '10 сек' },
      gemini: {
        desc: 'Локальний AI-помічник, який допомагатиме керувати календарем.',
        checking: 'Перевіряю…',
        active: 'Активний',
        missing: 'Не знайдено',
        installing: 'Встановлюю…',
        error: 'Помилка',
        install: 'Встановити',
        retry: 'Повторити',
        check: 'Перевірити'
      }
    }
  }
}
