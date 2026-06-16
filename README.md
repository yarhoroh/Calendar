# 🗓️ Calendar — desktop calendar with notes and a voice AI assistant

A Windows desktop app built on Electron: an infinite calendar, notes with
reminders, and a built-in **local AI assistant** that drives the calendar,
answers questions about your notes, and **speaks out loud** — all running
locally, no cloud.

---

## 📸 Screenshots

| Calendar, notes & file attachments | Reminders with a custom time picker |
| --- | --- |
| ![Calendar with notes and attachments](pic/calendar.png) | ![Reminder time picker](pic/reminders.png) |

| Settings — working days, voice, local AI | Built-in AI assistant |
| --- | --- |
| ![Settings](pic/settings.png) | ![AI assistant](pic/assistant.png) |

---

## ✨ Features

### Calendar & notes
- **Infinite day strip** — scroll left/right forever, smooth inertia and snap-to-day.
- **Per-day notes** — title, multi-line text, bold/italic, sizes, statuses.
- **Statuses, incl. custom** — built-in To do / In progress / Done, plus your own custom statuses (name + colour) managed in Settings and stored in the database; pick any status on notes across every board.
- **Drag-and-drop** — reorder notes within a day (a placeholder shows where it'll land), drag a note to **another day**, or drop it onto the **Every day / General / Today** buttons to move it between boards.
- **"Every day" board** — recurring notes shown on every day. Per note you can pick **which weekdays** it fires on (weekday squares in the time popover, defaulting to your working days; the chosen days show as a tooltip on the note's time). Toggle the checkbox next to **Every day** to also project these notes onto the matching weekday columns in the calendar.
- **"General" board** — plain notes (no reminder, no status) for storing info / scratch data.
- **Per-day sort** — click a day's header to cycle its note order: manual → by time ↑ → by time ↓ (saved per day).
- **Folder trees & a side panel** — a left panel (per board: Today / Every day / General) that **collapses to a single button, pins** (pushes the content) or **floats** over it (a floating panel closes when you click outside it), and **resizes** by dragging — all of it (open/pinned/width and the selected folder) is remembered per tab. Inside it you build a **folder tree**: create / rename / move (reparent) / delete folders, **drag a note onto a folder** to file it there, and **select a folder to filter** the notes (the calendar too) — it shows that folder and everything nested; the always-present **General** root shows all. A folder can't be deleted until its notes/subfolders are moved out. Each note shows its folder's name in the corner.
- **File attachments** — attach multiple files to any note via the paperclip, or **drag-and-drop from the desktop**; click a file to open it in its default app (Word/Excel/PDF/…). Files are linked by path, so edits stay in the original.
- **Reminders** — set a time on a note; when it's due a toast pops up in a separate window (with sound), clicking it opens that day.
- **Working days** — choose which weekdays count as working; "every day" reminders fire only on those days.
- **Navigation** — arrow buttons or **Ctrl + ← / →** move the calendar day-by-day; **Ctrl + drag** pans freely; horizontal wheel scrolls.
- **Expand a day** — double-click a day's header to blow that day up to the full window width; double-click again to collapse back to the strip.
- **Copy / paste / undo** — right-click a note to copy its title + text (newlines preserved); in the editor right-click to copy (selection or whole field) or paste at the cursor, and **Ctrl + Z** undoes recent edits.
- **SQLite storage** — fast and reliable, only the requested day is read.
- **Dark/light theme**, UI in **🇺🇦 Ukrainian / 🇬🇧 English**, frameless window, minimize to tray.

### 🤖 AI assistant (local CLI)
Chat with a local AI — **Gemini**, **Claude** or **Codex** CLI — your data is not sent to a third-party cloud:
- **Persistent & fast** — Gemini (ACP) and Claude (streaming JSON) run as live sessions; Codex resumes its session. Context is kept, replies are quick.
- **Pick the model** per engine in an editable config file (`ai-config.json`), or just ask the assistant to switch model — it rewrites the config and restarts itself. (A bad model self-heals back to the default.)
- **Reads notes on demand** — the assistant requests only the date/range it needs (`getNotes`), so it scales to any number of notes instead of stuffing them all into every prompt.
- **Controls the UI:** "go to this date", "open the every-day board", "expand fullscreen".
- **Creates, edits, sorts and deletes** notes & reminders by voice/text: "meeting the day after tomorrow at 9am", "rename this note", "mark it done", "put it in the Work folder".
- **Manages the folder trees** — it can create, rename, move (reparent) and delete folders on any board, and file one or many notes into them. It sees each board's tree (with ids) and every note's current folder.
- **Manages statuses** — it can create custom statuses (name + colour) and apply built-in or custom statuses to one or many notes.
- **Multi-step actions with feedback** — after it acts, the app sends the result back (the new id of anything created, or a failure reason), so it can chain dependent steps (e.g. *create a folder → file a note into it*) and report honestly instead of claiming success when something failed.
- **Four ways to respond** — a normal text reply, **speak** out loud, a **silent toast** near the clock, or a reply back to the **messenger** it was contacted from.
- **Knows the current date/time** and a 2-week date table — resolves "in a minute", "next Friday" correctly.

### 💬 Telegram & images
- **Telegram bridge** — connect a bot token in Settings and chat with the assistant from Telegram (long-polling, works behind NAT, no public webhook). Replies — and reminders it scheduled from Telegram — go back to that chat; a **Disconnect** button clears the token.
  - *Creating the bot:* open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a username — it replies with a token like `12345:ABC…`. Paste that token into Settings → *Bots & messengers* → Telegram, then message your new bot. (Keep the token private; if it leaks, use `/revoke` in @BotFather and paste the new one.)
- **Image understanding** — send a photo (with a caption) from Telegram, or **paste / drag-and-drop / attach** an image in the in-app chat, and the assistant sees it (vision on Claude, Gemini and Codex). Pasted images show removable thumbnail previews before sending.
- **Chat context persists** when you switch to Settings and back — cleared only when you clear it.

### 🔊 Voice (TTS)
- Two engines, switchable in Settings → Voice: **Piper** (bundled, offline, no Python; voices for **🇺🇦 / 🇷🇺 / 🇬🇧**) or the **system Windows** voices (SAPI). Windows TTS picks a voice by language (falling back to the Russian voice for Ukrainian if none is installed).
- The assistant **decides when to speak** (only when you ask) and in which language.
- **Playback queue** — phrases don't interrupt each other.
- **Audio server** on `127.0.0.1:51273` — any local process/agent can send text to be spoken:
  ```bash
  curl -X POST http://127.0.0.1:51273/speak \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"Hello!\",\"lang\":\"en\"}"
  ```

### 🧠 Assistant memory & tasks
- **Memory** — the assistant remembers preferences ("create tasks in Ukrainian, speak to me in Russian"). Viewable and editable in Settings.
- **Scheduled assistant tasks** — it (or you) schedules a task: **one-time** ("remind me in 30 min"), or **periodic** ("every hour", optionally within a **daily window** like 09:00–18:00). When it's due the assistant "wakes up" and acts (e.g. reads the morning agenda aloud, or nudges you to take a break). Each task remembers **where it was created** — a reminder set from Telegram is delivered back to Telegram, not spoken aloud. All visible in Settings (the "Assistant" tab).

---

## 🧩 Stack

| Layer | Tech |
|-------|------|
| Shell | Electron 33 + electron-vite 5 + Vite 7 |
| UI | React 19 (plain JavaScript, **no TypeScript**) |
| Storage | better-sqlite3 |
| AI | local Gemini (ACP) / Claude (stream-json) / Codex CLI |
| Voice | Piper (standalone, bundled in `resources/tts`) |
| Packaging | electron-builder (Windows NSIS) |

The codebase is decomposed into small modules — separate components, hooks,
icons and co-located CSS.

---

## 🚀 Getting started

```bash
npm install          # dependencies (native better-sqlite3 is rebuilt for Electron)
npm run dev          # development with hot reload
npm run build        # build without packaging
npm run dist         # build the .exe installer (Windows, into release/)
```

### Requirements for the AI chat
The chat works if one of these CLIs is installed and logged in (pick the engine in Settings):
- **Gemini CLI** — `npm i -g @google/gemini-cli`, then sign in with Google (`gemini`).
- **Claude CLI** — install and log in.
- **Codex CLI** — install and log in.

If no CLI is found / signed in, the calendar and notes still work — the chat just shows a "not found" status.

---

## 📁 Structure

```
src/
  main/        # Electron main: window, tray, DB, reminders,
               #   AI (acp.js / ai.js / prompt.js), TTS (tts.js / ttsServer.js),
               #   assistant task scheduler (aiTasks.js)
  preload/     # IPC bridge (window.api)
  renderer/    # React app (UI)
resources/
  tts/         # bundled Piper engine + voices (uk / ru / en)
  icon.png
```

---

## 🔒 Privacy

Notes and the database live **locally** on your machine (SQLite in `userData`).
Speech is synthesized **offline**. AI requests go through a local CLI that you
install and sign in to yourself.
