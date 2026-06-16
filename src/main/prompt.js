// Prompt construction shared by both AI backends: the one-shot CLI path
// (ai.js, claude) and the persistent ACP session (acp.js, gemini).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n) => String(n).padStart(2, '0')

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
          const text = (r.text || '').replace(/\s+/g, ' ').slice(0, 200)
          const time = r.time ? ` @${r.time}` : ''
          const files = r.files && r.files.length
            ? ` {files: ${r.files.map((f) => `${f.name}[id:${f.id}]`).join(', ')}}`
            : ''
          return `  - (id:${r.id}) [${status}]${time} ${title}${text}${files}`
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
  '[ {"action":"getNotes","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, {"action":"goto","date":"YYYY-MM-DD"}, {"action":"today"}, {"action":"everyday"}, {"action":"general"}, {"action":"expand","date":"YYYY-MM-DD"}, {"action":"addNote","date":"YYYY-MM-DD","title":"optional","text":"note text","time":"HH:mm optional"}, {"action":"reorder","date":"YYYY-MM-DD","ids":["id1","id2"]}, {"action":"delete","date":"YYYY-MM-DD","ids":["id1"]}, {"action":"speak","lang":"uk|ru|en","text":"what to say out loud"}, {"action":"remember","text":"a lasting fact/preference"}, {"action":"forget","id":"memoryId"}, {"action":"addAiTask","at":"YYYY-MM-DDTHH:mm","text":"what to do when it fires"}, {"action":"deleteAiTask","id":"taskId"}, {"action":"openFile","id":"attachmentId"}, {"action":"attachFile","noteId":"noteId","path":"C:\\\\path\\\\to\\\\file"}, {"action":"setModel","model":"gpt-5.4-mini","reasoning":"low"} ]'

function formatMemory(rows) {
  if (!rows || !rows.length) return '(nothing remembered yet)'
  return rows.map((r) => `  - (id:${r.id}) ${r.text}`).join('\n')
}

function formatAiTasks(rows) {
  if (!rows || !rows.length) return '(no scheduled tasks)'
  return rows
    .map((r) => `  - (id:${r.id}) [${r.done ? 'done' : 'pending'}] at ${r.at}: ${r.text}`)
    .join('\n')
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
  const { memory, tasks, configPath } = ctx
  const now = new Date()
  return [
    'You are the built-in assistant of a desktop calendar + notes app. Your job is to help the user manage their schedule, notes and reminders.',
    "Treat every message as being about the user's calendar, notes or day unless they clearly change the subject. Stay in this role across the whole conversation.",
    'Do NOT run shell commands, read or write files, or use any external tools — you only chat and emit the calendar action block described below.',
    "You are NOT given the user's notes up front. When you need to read notes (to answer a question, find or sort something), request them with the getNotes action and you'll receive them, then answer.",
    'Always reply in the same language the user writes in.',
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
    'To act or read notes, append to the very end of your reply a fenced block:',
    '```calendar',
    ACTION_BLOCK,
    '```',
    'getNotes = read notes for a date or range when you need them: {"action":"getNotes","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (single day: just "from"; the recurring/info boards: {"action":"getNotes","board":"everyday"} or "general"). When you need notes, reply with ONLY this block and no other text — you will receive the notes back, then give your real answer. Request the smallest range that answers the question.',
    "Actions: goto = scroll to a date; today = today (normal calendar); everyday = recurring board; general = open the general (plain info) notes board; expand = day full-screen; addNote = create a note (time HH:mm = reminder; date \"everyday\" = recurring; date \"general\" = plain info note, no time/status). Each note above shows its (id:...). reorder = set the new order of a day's notes by listing their ids in the desired order (sort by time/status/etc.). delete = remove notes by id (e.g. delete all [done] on a date — list those ids).",
    "speak = say text out loud through the built-in voice. Use it ONLY when the user explicitly asks to hear something (\"read me today's tasks\", \"tell me…\", \"say it out loud\") OR when one of your scheduled tasks fires and asks you to speak; NEVER speak unprompted. Set \"lang\" to the language of the spoken text (uk / ru / en).",
    'remember = store a lasting fact/preference (use the user\'s own wording). forget = delete a memory by its id (shown in MEMORY).',
    'addAiTask = schedule a task for yourself at a local datetime "YYYY-MM-DDTHH:mm"; when it fires you will be asked to do its text (e.g. {"action":"addAiTask","at":"2026-06-16T09:00","text":"speak the morning agenda in Russian"}). deleteAiTask = remove a scheduled task by its id (shown in AI TASKS).',
    'openFile = open a note\'s attached file in its default app (Word/Excel/PDF/…) by the attachment id shown after the note as {files: name[id:..]}. attachFile = attach a file already on disk to a note (note id + absolute path).',
    `setModel = change the model of the CURRENT engine (the one you are) and restart it with that model, e.g. {"action":"setModel","model":"gpt-5.5","reasoning":"medium"} (reasoning is codex-only). Models are stored in the editable text config file ${configPath || 'ai-config.json'} (keys: geminiModel, claudeModel, codexModel, codexReasoning — empty = that CLI's default); the user can also edit that file by hand and the change applies on the next start.`,
    'Rules: every date in an action is YYYY-MM-DD taken from the DATES table above. Keep the spoken reply short. If the request is ambiguous, ask a clarifying question and emit NO calendar block.'
  ].join('\n')
}

// Compact refresh for continued ACP turns: the session already holds the role
// and protocol, so we only refresh the volatile data (time, dates, notes) plus
// a short reminder of the action-block format.
export function buildRefresh(ctx = {}) {
  const { memory, tasks } = ctx
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
    'Need notes? Use getNotes (reply with only that block). When an action is needed, end your reply with the ```calendar block:',
    ACTION_BLOCK
  ].join('\n')
}

export function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return ''
}
