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
      stop: 'Stop',
      attachImage: 'Attach image',
      removeImage: 'Remove image'
    },
    calendar: { prev: 'Previous', next: 'Next', today: 'Today', pickDate: 'Pick a date', everyday: 'Every day', general: 'General' },
    items: {
      placeholder: 'Write a note…',
      titlePlaceholder: 'Title',
      copy: 'Copy',
      paste: 'Paste',
      reminder: 'Reminder',
      clearReminder: 'Clear reminder',
      status: { todo: 'To do', doing: 'In progress', done: 'Done', cancelled: 'Cancelled' }
    },
    chat: { clear: 'Clear context', ready: 'AI ready', starting: 'Starting AI…', offline: 'AI not found' },
    panel: { open: 'Open panel', collapse: 'Collapse', pin: 'Pin / unpin', resize: 'Drag to resize' },
    folders: {
      newName: 'Folder name…',
      addChild: 'New subfolder',
      rename: 'Rename',
      delete: 'Delete',
      hasNotes: 'Move its notes out first.',
      hasSubfolders: 'Delete or empty its subfolders first.'
    },
    attach: { title: 'Attachments', add: 'add files', remove: 'Remove', empty: 'No files attached.' },
    settings: {
      tools: 'Local AI tools',
      bots: 'Bots & messengers',
      aiEngine: 'AI engine',
      language: 'Language',
      autostart: 'Launch on startup',
      reminderSound: 'Notification sound',
      showChat: 'Show chat field',
      voice: 'Voice',
      voiceDesc: 'Local text-to-speech (Piper). The AI and reminders can speak.',
      voiceTest: 'Test',
      workingDays: 'Working days',
      workingDaysDesc: '"Every day" reminders fire only on these days.',
      aiConfigFile: 'AI config file',
      open: 'Open',
      folder: 'Folder',
      tg: {
        desc: 'Chat with the assistant from Telegram. Paste your bot token (@BotFather).',
        token: 'Bot token',
        on: 'Connected',
        off: 'Off',
        bad: 'Bad token',
        disconnect: 'Disconnect'
      },
      tabGeneral: 'General',
      tabAi: 'Assistant',
      statuses: 'Custom statuses',
      statusesEmpty: 'No custom statuses yet.',
      statusAdd: 'New status name…',
      memory: 'AI memory',
      aiTasks: 'AI tasks',
      memoryEmpty: 'Nothing remembered yet.',
      memoryAdd: 'Add a note for the AI…',
      tasksEmpty: 'No scheduled tasks.',
      add: 'Add',
      delete: 'Delete',
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
      stop: 'Зупинити',
      attachImage: 'Додати зображення',
      removeImage: 'Прибрати зображення'
    },
    calendar: { prev: 'Назад', next: 'Вперед', today: 'Сьогодні', pickDate: 'Обрати дату', everyday: 'Щодня', general: 'Загальні' },
    items: {
      placeholder: 'Напишіть нотатку…',
      titlePlaceholder: 'Заголовок',
      copy: 'Копіювати',
      paste: 'Вставити',
      reminder: 'Нагадування',
      clearReminder: 'Прибрати нагадування',
      status: { todo: 'Не виконано', doing: 'В роботі', done: 'Виконано', cancelled: 'Скасовано' }
    },
    chat: { clear: 'Очистити контекст', ready: 'AI готовий', starting: 'Запуск AI…', offline: 'AI не знайдено' },
    panel: { open: 'Відкрити панель', collapse: 'Згорнути', pin: 'Закріпити / відкріпити', resize: 'Потягни, щоб змінити розмір' },
    folders: {
      newName: 'Назва папки…',
      addChild: 'Нова підпапка',
      rename: 'Перейменувати',
      delete: 'Видалити',
      hasNotes: 'Спершу перенеси з неї нотатки.',
      hasSubfolders: 'Спершу видали або очисти підпапки.'
    },
    attach: { title: 'Вкладення', add: 'додати файли', remove: 'Прибрати', empty: 'Файлів немає.' },
    settings: {
      tools: 'Локальні AI-інструменти',
      bots: 'Боти та месенджери',
      aiEngine: 'AI-рушій',
      language: 'Мова',
      autostart: 'Запускати під час старту системи',
      reminderSound: 'Звук сповіщення',
      showChat: 'Показувати поле чату',
      voice: 'Голос',
      voiceDesc: 'Локальна озвучка (Piper). AI та нагадування можуть говорити.',
      voiceTest: 'Перевірити',
      workingDays: 'Робочі дні',
      workingDaysDesc: 'Нагадування «кожен день» спрацьовують лише в ці дні.',
      aiConfigFile: 'Файл конфігу AI',
      open: 'Відкрити',
      folder: 'Папка',
      tg: {
        desc: 'Спілкуйтесь з асистентом у Telegram. Встав токен бота (@BotFather).',
        token: 'Токен бота',
        on: 'Підключено',
        off: 'Вимкнено',
        bad: 'Невірний токен',
        disconnect: 'Відключити'
      },
      tabGeneral: 'Загальні',
      tabAi: 'Асистент',
      statuses: 'Власні статуси',
      statusesEmpty: 'Власних статусів ще немає.',
      statusAdd: 'Назва нового статусу…',
      memory: 'Пам’ять AI',
      aiTasks: 'Завдання AI',
      memoryEmpty: 'Поки нічого не запам’ятовано.',
      memoryAdd: 'Додати нотатку для AI…',
      tasksEmpty: 'Немає запланованих завдань.',
      add: 'Додати',
      delete: 'Видалити',
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
