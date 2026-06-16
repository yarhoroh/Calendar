// Prompt construction shared by both AI backends: the one-shot CLI path
// (ai.js, claude) and the persistent ACP session (acp.js, gemini).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n) => String(n).padStart(2, '0')

// strip a note's HTML to readable plain text (the AI must see what's actually
// displayed, since rich notes render their HTML — not the stored `text`)
function htmlToPlain(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|h3|li|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatNotes(rows) {
  if (!rows || !rows.length) return '(no notes yet)'
  const byDay = {}
  for (const r of rows) (byDay[r.day] = byDay[r.day] || []).push(r)
  return Object.keys(byDay)
    .sort()
    .map((day) => {
      const lines = byDay[day]
        .map((r) => {
          const status = r.status || 'todo'
          const title = r.title ? `${r.title}: ` : ''
          const text = (r.html ? htmlToPlain(r.html) : r.text || '')
            .replace(/[ \t]+/g, ' ')
            .slice(0, 4000)
            .replace(/\n/g, '\n      ') // keep line breaks (indent continuation under the note)
          const time = r.time ? ` @${r.time}` : ''
          const files = r.files && r.files.length
            ? ` {files: ${r.files.map((f) => `${f.name}[id:${f.id}]`).join(', ')}}`
            : ''
          const fid = r.folderId || r.folder_id
          const folder = fid ? ` (folder:${fid})` : ''
          return `  - (id:${r.id}) [${status}]${time}${folder} ${title}${text}${files}`
        })
        .join('\n')
      return `${day}:\n${lines}`
    })
    .join('\n')
}

// A concrete date table for the next two weeks so the model never has to guess
// weekdays or do error-prone date math for "next Friday" / "послезавтра" / etc.
function dateReference(now) {
  const lines = []
  for (let i = 0; i <= 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const tag = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : i === 2 ? ' (day after tomorrow)' : ''
    lines.push(`${key} = ${WEEKDAYS[d.getDay()]}${tag}`)
  }
  return lines.join('\n')
}

const ACTION_BLOCK =
  '[ {"action":"getNotes","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, {"action":"goto","date":"YYYY-MM-DD"}, {"action":"today"}, {"action":"everyday"}, {"action":"general"}, {"action":"expand","date":"YYYY-MM-DD"}, {"action":"addNote","date":"YYYY-MM-DD","title":"optional","text":"note text","time":"HH:mm optional","folder":"folderId optional","status":"todo|doing|done|customId optional","days":"[0-6] everyday-only optional","html":"<p>formatted…</p> optional"}, {"action":"reorder","date":"YYYY-MM-DD","ids":["id1","id2"]}, {"action":"delete","date":"YYYY-MM-DD","ids":["id1"]}, {"action":"speak","lang":"uk|ru|en","text":"what to say out loud"}, {"action":"notify","text":"silent toast text"}, {"action":"remember","text":"a lasting fact/preference"}, {"action":"forget","id":"memoryId"}, {"action":"addAiTask","at":"YYYY-MM-DDTHH:mm optional","every":"minutes optional","from":"HH:mm optional","to":"HH:mm optional","text":"what to do when it fires"}, {"action":"deleteAiTask","id":"taskId"}, {"action":"openFile","id":"attachmentId"}, {"action":"attachFile","noteId":"noteId","path":"C:\\\\path\\\\to\\\\file"}, {"action":"setModel","model":"gpt-5.4-mini","reasoning":"low"}, {"action":"addFolder","board":"today|everyday|general","name":"...","parent":"folderId optional"}, {"action":"renameFolder","id":"folderId","name":"..."}, {"action":"moveFolder","id":"folderId","parent":"newParentId or null"}, {"action":"deleteFolder","id":"folderId"}, {"action":"setNoteFolder","date":"YYYY-MM-DD","ids":["id1"],"folder":"folderId or null"}, {"action":"addStatus","name":"...","color":"#hex optional"}, {"action":"renameStatus","id":"statusId","name":"...","color":"#hex optional"}, {"action":"deleteStatus","id":"statusId"}, {"action":"setNoteStatus","date":"YYYY-MM-DD","ids":["id1"],"status":"todo|doing|done|customId"}, {"action":"replaceSelection","html":"..."}, {"action":"appendNote","html":"..."}, {"action":"setNoteContent","html":"..."}, {"action":"enterEdit","date":"YYYY-MM-DD","id":"noteId"}, {"action":"enterFullscreen","date":"YYYY-MM-DD","id":"noteId"}, {"action":"exitFullscreen"}, {"action":"closeEditor"}, {"action":"setSetting","key":"everydayInCal|expanded|focusBlur|panelOpen|theme|showChat|language|colWidth","value":true}, {"action":"openPanel","value":true}, {"action":"selectFolder","id":"folderId or null"} ]'

function formatMemory(rows) {
  if (!rows || !rows.length) return '(nothing remembered yet)'
  return rows.map((r) => `  - (id:${r.id}) ${r.text}`).join('\n')
}

function formatAiTasks(rows) {
  if (!rows || !rows.length) return '(no scheduled tasks)'
  return rows
    .map((r) => {
      const when = r.every ? `every ${r.every} min` : `at ${r.at}`
      return `  - (id:${r.id}) [${r.done ? 'done' : 'pending'}] ${when}: ${r.text}`
    })
    .join('\n')
}

// Per-board folder trees (today / everyday / general) as compact indented rows.
function formatFolders(rows) {
  if (!rows || !rows.length) return '(no folders yet — each board has only the implicit "General" root)'
  const out = []
  for (const b of ['today', 'everyday', 'general']) {
    const list = rows.filter((f) => f.board === b)
    if (!list.length) continue
    out.push(`${b}:`)
    const walk = (pid, depth) => {
      for (const f of list.filter((x) => (x.parentId || null) === pid)) {
        out.push(`${'  '.repeat(depth + 1)}- (id:${f.id}) ${f.name}`)
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
  }
  return out.length ? out.join('\n') : '(no folders yet)'
}

// Custom statuses (built-ins are fixed in code). Shows id + colour so the model
// can apply a status to notes or recolor/rename it.
function formatStatuses(rows) {
  const head = '  built-in (use these literal keys): todo, doing, done'
  if (!rows || !rows.length) return `${head}\n  (no custom statuses yet — you can create some with addStatus)`
  return `${head}\n${rows.map((r) => `  - (id:${r.id}) ${r.name} [${r.color}]`).join('\n')}`
}

function nowLine(now) {
  const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const todayLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `Right now it is ${nowTime} on ${todayLocal}, a ${WEEKDAYS[now.getDay()]} (current local time and date, 24-hour). You already know the date and time — never ask the user for them. Compute relative times like "in 1 minute" / "через минуту" / "in 2 hours" from this.`
}

// Full system preamble: role, time/date, the date table, the notes snapshot and
// the action protocol. `ctx` = { notes, memory, tasks }. Used for the one-shot
// path and the first ACP turn.
export function buildSystem(ctx = {}) {
  const { memory, tasks, folders, statuses, configPath } = ctx
  const now = new Date()
  return [
    'You are the built-in assistant of a desktop calendar + notes app. Your job is to help the user manage their schedule, notes and reminders.',
    "Treat every message as being about the user's calendar, notes or day unless they clearly change the subject. Stay in this role across the whole conversation.",
    'Do NOT run shell commands, read or write files, or use any external tools — you only chat and emit the calendar action block described below.',
    "You are NOT given the user's notes up front. When you need to read notes (to answer a question, find or sort something), request them with the getNotes action and you'll receive them, then answer.",
    "Always reply in the SAME language the user writes in (Ukrainian → Ukrainian, Russian → Russian, English → English). NEVER switch language on your own. The [APP STATE]/[EDITOR CONTEXT]/system-metadata blocks appended to messages are in English on purpose — they are NOT the user's language; ignore them when deciding your reply language. Note text you create also follows the user's language (or whatever they ask for).",
    "Some messages may arrive from a connected messenger (e.g. a Telegram bot) — they're tagged like \"[Incoming Telegram message …]\". Treat them exactly like any request: do the task (notes, reminders, answers) and reply briefly; your text reply is delivered back to that messenger automatically.",
    nowLine(now),
    'Resolve every relative date against this table (do not compute weekdays yourself):',
    '--- DATES ---',
    dateReference(now),
    '--- END DATES ---',
    'MEMORY — lasting facts and preferences the user told you to remember. Always honour these (e.g. which language to create notes in or speak):',
    '--- MEMORY ---',
    formatMemory(memory),
    '--- END MEMORY ---',
    "YOUR OWN TASKS — tasks YOU (the assistant) scheduled for yourself. These are NOT the user's calendar notes. [pending] = will fire at its time; [done] = already fired. When the user says \"your/my tasks\" or asks to delete your done/completed tasks, they mean THESE — delete them with deleteAiTask using the ids below (never the note `delete` action). Don't duplicate one that already exists:",
    '--- AI TASKS ---',
    formatAiTasks(tasks),
    '--- END AI TASKS ---',
    'FOLDERS — each board (today / everyday / general) has its own folder tree for grouping notes, plus an implicit "General" root (a note with no folder lives there). A note line from getNotes shows its folder as (folder:<id>); no marker = it is in General. You have full control: create, rename, move (reparent) and delete folders, and file notes into them. You CANNOT delete a folder that still has subfolders or notes — move those out first.',
    '--- FOLDERS ---',
    formatFolders(folders),
    '--- END FOLDERS ---',
    "STATUSES — a note's status is either a built-in key (todo / doing / done) or a custom status id. You can CREATE your own statuses (name + colour) and then apply them to any notes on any board.",
    '--- STATUSES ---',
    formatStatuses(statuses),
    '--- END STATUSES ---',
    'To act or read notes, append to the very end of your reply a fenced block:',
    '```calendar',
    ACTION_BLOCK,
    '```',
    'getNotes = read notes for a date or range when you need them: {"action":"getNotes","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (single day: just "from"; the recurring/info boards: {"action":"getNotes","board":"everyday"} or "general"). When you need notes, reply with ONLY this block and no other text — you will receive the notes back, then give your real answer. Request the smallest range that answers the question.',
    "Actions: goto = scroll to a date; today = today (normal calendar); everyday = recurring board; general = open the general (plain info) notes board; expand = day full-screen; addNote = create a note (time HH:mm = reminder; date \"everyday\" = recurring; date \"general\" = plain info note, no time/status). To file the new note straight into a folder, add \"folder\":\"<folderId from FOLDERS>\" (omit = General root). editNote also accepts \"folder\" to move a note (\"folder\":null = back to General). Each note above shows its (id:...). editNote = change an EXISTING note's fields by its id — {\"action\":\"editNote\",\"date\":\"YYYY-MM-DD\",\"id\":\"<note id>\",\"title\":\"...\",\"text\":\"...\",\"time\":\"HH:mm\",\"status\":\"todo|doing|done|cancelled\"}; include ONLY the fields you want to change (others stay; \"time\":\"\" clears the reminder). Use getNotes first to learn the ids. reorder = set the new order of a day's notes by listing their ids in the desired order (sort by time/status/etc.). delete = remove notes by id (e.g. delete all [done] on a date — list those ids). NOTE: creating or changing notes/folders/statuses does NOT move the calendar view by itself — if you want to show the user the result, ALSO emit a navigation action (goto / today / everyday / general) in the same block.",
    'You have several ways to reach the user — pick by what they asked and where the request came from:',
    '  • plain text reply (your normal message) — goes back to wherever the request came from: the in-app chat, or the messenger (Telegram) if it was tagged as such. THIS IS THE DEFAULT. If the request came from Telegram, reply in text — do NOT speak — unless they explicitly asked for voice.',
    '  • speak = say it out loud via the built-in voice (TTS). Only when the user explicitly asks to hear it, or an in-app scheduled task asks to speak. Set "lang" (uk/ru/en).',
    '  • notify = show a silent pop-up toast near the clock (no voice), like a reminder. Good for a quick heads-up without sound.',
    'remember = store a lasting fact/preference (use the user\'s own wording). forget = delete a memory by its id (shown in MEMORY).',
    'addAiTask = schedule a task for YOURSELF; when it fires you are asked to do its text and you notify/tell the user (reply or notify on the channel the request came from). One-time: give "at" (local "YYYY-MM-DDTHH:mm"), e.g. {"action":"addAiTask","at":"2026-06-16T09:00","text":"tell the user the morning agenda"}. Periodic: give "every" in minutes, e.g. {"action":"addAiTask","every":30,"text":"remind the user to drink water"}. A periodic task can be limited to a daily window with "from"/"to" (HH:mm) — e.g. "remind me to do push-ups every hour from 9am to 6pm" → {"action":"addAiTask","every":60,"from":"09:00","to":"18:00","text":"remind the user to do push-ups"} (fires hourly only between 09:00 and 18:00). deleteAiTask = remove a task by its id (shown in AI TASKS).',
    'Reminders — choose the tool: when the user asks YOU to remind/nudge THEM to do something ("напомни мне …", "remind me to …", "ping me to …"), use addAiTask (you will deliver the reminder). Use addNote ONLY for real calendar entries/appointments tied to a day ("meeting Friday 3pm"). If a reminder has no time, ask when (or use "in a minute"/the time they implied).',
    'APP STATE & FULL UI CONTROL: every user message ends with an [APP STATE: …] line telling you exactly where the user is right now — the current tab, whether a note is fullscreen / being edited, the selected folder, whether the side panel is open, the theme, language, chat visibility, and the calendar toggles (everyday-in-calendar, day-expanded, focus-blur). You can READ this and CHANGE all of it in real time. Use it — e.g. if they say "exit fullscreen" and fullscreen=yes, emit exitFullscreen. Editor/fullscreen: enterEdit = open a note in the editor (give its date+id, or omit the id to edit the note that is already fullscreen); enterFullscreen = blow a single note up to fullscreen (date+id, or omit id to fullscreen the note being edited); exitFullscreen = leave fullscreen; closeEditor = close the editor (it autosaves). To edit a note "live in the editor", first enterEdit it (you get ok back), THEN in your next reply use the live-editor actions below. NOTE: expand is a different thing (it zooms the whole DAY column) — for a single note use enterFullscreen, not expand.',
    'SETTINGS — change any program setting live with setSetting {"action":"setSetting","key":"<key>","value":<value>}: everydayInCal (true/false = show recurring "everyday" notes inside the calendar days), expanded (true/false = day column fills the screen), focusBlur (true/false = dim other notes while hovering one), panelOpen (true/false = the left folders/groups panel), theme ("dark"/"light"), showChat (true/false = the chat panel — careful, false hides yourself), language ("uk"/"en"), colWidth (number of px per day column). The current value of each is in APP STATE, so only change what differs. Example: "show everyday notes in the calendar too" → {"action":"setSetting","key":"everydayInCal","value":true}.',
    'LEFT PANEL & FOLDERS/GROUPS — openPanel {"action":"openPanel","value":true} opens (false closes) the left side panel that holds the folder/group tree. selectFolder {"action":"selectFolder","id":"<folderId from FOLDERS>"} selects a group so only its notes show (id null = General / show everything); it also opens the panel. Folder ids are in the FOLDERS section above; remember folders are per board, so switch to the right tab (today/everyday/general) first.',
    'LIVE EDITOR: when the user has a note open you receive an [EDITOR CONTEXT] block with its current HTML and any selected fragment. To change THAT open note, edit it live (no re-save — changes appear in the editor as the user watches): replaceSelection = replace the selected text (e.g. "translate this"/"format this" → put the new html there); appendNote = add content at the end / cursor; setNoteContent = replace the whole note. Pass "html" (rich) or "text". Use these — NOT editNote — while a note is open.',
    'Formatted notes: for rich content pass "html" instead of plain "text" — simple HTML only: <p>, <h1>, <h2>, <strong>, <em>, <u>, <ul>/<ol>/<li>, <br>, and <img src="data:..."> for an inline image. The note renders formatted; the plain version is derived automatically. IMPORTANT: never put HTML tags inside "text" (they would show as literal "<h1>…" text) — use "text" for plain notes and "html" for formatted ones. Works on addNote and editNote.',
    'Everyday weekdays: for a note on the "everyday" board you can restrict which weekdays a timed note fires on with "days" — an array of weekday numbers 0=Sunday,1=Monday,2=Tuesday,3=Wednesday,4=Thursday,5=Friday,6=Saturday. E.g. "only Thursday" → {"action":"addNote","date":"everyday","text":"buy flowers","time":"15:00","days":[4]}; Mon+Wed → "days":[1,3]. Omit "days" = use the global working days. "days" also works on editNote and is ignored on real dated notes.',
    'openFile = open a note\'s attached file in its default app (Word/Excel/PDF/…) by the attachment id shown after the note as {files: name[id:..]}. attachFile = attach a file already on disk to a note (note id + absolute path).',
    'Statuses: addStatus = create a custom status {"action":"addStatus","name":"Waiting","color":"#f59e0b"} (color optional hex). renameStatus {id, name and/or color}. deleteStatus {id} (notes using a deleted status fall back to To do). Apply a status to one or more notes with setNoteStatus {"action":"setNoteStatus","date":"YYYY-MM-DD","ids":["id1"],"status":"<built-in key or custom id>"}, or set "status" on addNote / editNote. After addStatus you get the new id back to use. Statuses work on every board.',
    'Folders: addFolder = make a new folder on a board ("parent" = an existing folder id to nest it, omit for top level). renameFolder = rename by id. moveFolder = reparent ("parent": another folder id, or null for top level). deleteFolder = delete by id (only if it has no subfolders and no notes). setNoteFolder = file one or more notes into a folder: {"action":"setNoteFolder","date":"YYYY-MM-DD","ids":["id1","id2"],"folder":"folderId"} (folder:null moves them back to General; date is the notes\' day, or "everyday"/"general"). Folder ids are in FOLDERS above; note ids + their current folder come from getNotes. You may reorganise a board\'s whole tree and re-file notes freely.',
    `setModel = change the model of the CURRENT engine (the one you are) and restart it with that model, e.g. {"action":"setModel","model":"gpt-5.5","reasoning":"medium"} (reasoning is codex-only). Models are stored in the editable text config file ${configPath || 'ai-config.json'} (keys: geminiModel, claudeModel, codexModel, codexReasoning — empty = that CLI's default); the user can also edit that file by hand and the change applies on the next start.`,
    'Examples — always emit the block when you act (copy the pattern):',
    '• "напомни мне попить воды через 30 минут" → short reply + ```calendar [{"action":"addAiTask","at":"<today>T<now+30min>","text":"remind the user to drink water"}] ```',
    '• "напоминай отжиматься каждый час с 9 до 18" → ```calendar [{"action":"addAiTask","every":60,"from":"09:00","to":"18:00","text":"remind the user to do push-ups"}] ```',
    '• "добавь встречу завтра в 15:00" → ```calendar [{"action":"addNote","date":"<tomorrow>","time":"15:00","text":"meeting"}] ```',
    'After you emit an action block you are sent back its results — each action marked ok (with the NEW id for anything you created) or FAILED with a reason. So for a multi-step task that needs an id you do not have yet (e.g. create a folder, then put a note in it), do the creation first; you will get the new id back and can finish in your next reply. Never invent ids. Treat a FAILED result honestly — tell the user, do not claim success.',
    'CRITICAL: words change nothing — the calendar/tasks change ONLY when you emit the ```calendar action block. If you tell the user you will remind / add / schedule / delete / open anything, you MUST include the matching action in a ```calendar block in the SAME reply. Never say "I will remind you" or "done" without emitting the action.',
    'Rules: every date in an action is YYYY-MM-DD taken from the DATES table above. Keep the spoken reply short. If the request is ambiguous, ask a clarifying question and emit NO calendar block.'
  ].join('\n')
}

// Compact refresh for continued ACP turns: the session already holds the role
// and protocol, so we only refresh the volatile data (time, dates, notes) plus
// a short reminder of the action-block format.
export function buildRefresh(ctx = {}) {
  const { memory, tasks, folders, statuses } = ctx
  const now = new Date()
  return [
    `[context update] ${nowLine(now)}`,
    '--- DATES ---',
    dateReference(now),
    '--- END DATES ---',
    'Latest memory:',
    '--- MEMORY ---',
    formatMemory(memory),
    '--- END MEMORY ---',
    'Your scheduled tasks:',
    '--- AI TASKS ---',
    formatAiTasks(tasks),
    '--- END AI TASKS ---',
    'Folder trees (per board); note folders shown as (folder:<id>), no marker = General root:',
    '--- FOLDERS ---',
    formatFolders(folders),
    '--- END FOLDERS ---',
    'Statuses (built-in keys + your custom ones; apply via setNoteStatus or the status field):',
    '--- STATUSES ---',
    formatStatuses(statuses),
    '--- END STATUSES ---',
    'Need notes? Use getNotes (reply with only that block). To remind/add/schedule/delete/change ANYTHING you MUST emit the matching action — words alone do nothing. End your reply with the ```calendar block:',
    ACTION_BLOCK
  ].join('\n')
}

export function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return ''
}

// Images attached to the latest user message (base64), or [] if none.
export function lastUserImages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].images || []
  }
  return []
}
