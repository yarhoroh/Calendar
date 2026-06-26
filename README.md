# 🗓️ Calendar — desktop calendar + email with a voice AI assistant

A Windows desktop app built on Electron: an infinite calendar, notes with
reminders, a built-in **IMAP email client**, and a **local AI assistant** that
drives the calendar **and your mail**, answers questions about your notes,
**listens to your voice** and **speaks out loud** — all running locally, no cloud.

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
- **Per-day notes** — a title plus a **rich-text body** (Tiptap): bold / italic / underline by selection, headings/sizes, bullet & numbered lists. Notes are stored as HTML; the view renders the same.
- **Inline images** — paste (Ctrl+V), drag-and-drop or attach images straight into a note; they're embedded as **base64** at the cursor, can be **resized** by dragging their handles and moved within the note.
- **Safe delete** — removing a note asks for confirmation first.
- **Statuses, incl. custom** — built-in To do / In progress / Done, plus your own custom statuses (name + colour) managed in Settings and stored in the database; pick any status on notes across every board.
- **Drag-and-drop** — reorder notes within a day (a placeholder shows where it'll land), drag a note to **another day**, or drop it onto the **Every day / General / Today** buttons to move it between boards.
- **"Every day" board** — recurring notes shown on every day. Per note you can pick **which weekdays** it fires on (weekday squares in the time popover, defaulting to your working days; the chosen days show as a tooltip on the note's time). Toggle the checkbox next to **Every day** to also project these notes onto the matching weekday columns in the calendar. When projected, a **status set on a given day applies only to that day** (mark it done on one date without changing the recurring note on the others).
- **"General" board** — plain notes (no reminder, no status) for storing info / scratch data.
- **Per-day sort** — click a day's header to cycle its note order: manual → by time ↑ → by time ↓ (saved per day).
- **Read focus** — hold the cursor on a note (~2s) and the others blur so it reads clearly (toggle in Settings). A tall note also gets a **fullscreen** button (⛶) to open it full-window, scroll and edit it; the same ⛶ **collapses** it back to the column, or ✕ closes the editor.
- **Folder trees & a side panel** — a left panel (per board: Today / Every day / General) that **collapses to a single button, pins** (pushes the content) or **floats** over it (a floating panel closes when you click outside it), and **resizes** by dragging — all of it (open/pinned/width and the selected folder) is remembered per tab. Inside it you build a **folder tree**: create / rename / move (reparent) / delete folders, **drag a note onto a folder** to file it there, and **select a folder to filter** the notes (the calendar too) — it shows that folder and everything nested; the always-present **General** root shows all — or, with a Settings toggle (overridable **per board** via a little three-state switch in the panel header: off / auto / on), only the **unsorted** notes that aren't filed into any folder. A folder can't be deleted until its notes/subfolders are moved out. Each note shows its folder's name in the corner.
- **File attachments** — attach multiple files to any note via the paperclip, or **drag-and-drop from the desktop**. Each file shows its **Windows file-type icon**; click the name to open it in its default app (Word/Excel/PDF/…), the **folder** button reveals it in Explorer, and **✕** detaches it. Files are linked by path, so edits stay in the original.
- **Reminders** — set a time on a note; when it's due a toast pops up in a separate window (with sound), clicking it opens that day.
- **Working days** — choose which weekdays count as working; "every day" reminders fire only on those days.
- **Navigation** — arrow buttons or **Ctrl + ← / →** move the calendar day-by-day; **Ctrl + drag** pans freely; horizontal wheel scrolls.
- **Expand a day** — double-click a day's header to blow that day up to the full window width; double-click again to collapse back to the strip.
- **Copy / paste / undo** — right-click a note to copy its title + text (newlines preserved); in the editor right-click to copy (selection or whole field) or paste at the cursor, and **Ctrl + Z** undoes recent edits.
- **SQLite storage** — fast and reliable, only the requested day is read.
- **Auto-update** — the installed app checks GitHub on launch, downloads new versions in the background and offers to **restart now / later** (installs on quit); you can also **check manually** in Settings.
- **Dark/light theme**, UI in **🇺🇦 Ukrainian / 🇬🇧 English**, frameless window, minimize to tray.

### 📧 Email client (IMAP)
- **Multiple IMAP accounts** — add Gmail (or any IMAP) mailboxes with an app password in Settings → *Email*; the password is encrypted with the OS keychain (`safeStorage`). A **unified "All inboxes" / "All sent"** view spans every account, plus a per-account folder tree (Inbox / Sent / Trash / Spam / labels), resolved by **special-use** so Gmail's localized folder names (`Sent Mail` → `Надіслані`, etc.) work across accounts.
- **Conversation threading** — messages group into Gmail-style threads (one row per conversation, with the full message count). The reader **streams** the thread in newest-first, showing the first message instantly and a "loading more" indicator while the rest arrive.
- **Infinite scroll** — the list loads the newest 50 and pulls in more as you scroll (no page buttons); after a delete it tops the window back up. A 20s incremental poll merges genuinely-new mail in **at the top** without reloading.
- **Fast, optimistic UI** — instant cache flash from a local SQLite mirror, switching folders clears the list immediately (no stale flash), optimistic delete / mark-read with tombstones until the server confirms, and the cache is reconciled with the server so mail you deleted in Gmail stops "ghosting". Folder unread badges refresh in the background across all accounts.
- **Full-mailbox search** — searches every folder (incl. Trash/Spam, by sender name, substring) and streams matches in; hits are faintly highlighted.
- **Reader** — sender/recipient/time/star skeleton from the list metadata (no flicker), selectable headers, per-message translate (Google) and a **zoom** control (buttons + Ctrl+scroll, body only). **Sent** folders show the **recipient**, and group into threads like the inbox.
- **In-app web viewer** — open a link from an email in an isolated `<webview>`: **translate the page** in place, or **summarize it into a clean reader** (medium / brief / key points), with its own zoom. Plain click → system browser, Ctrl+click → in-app.
- **Read aloud & "speak the selection"** — read an article/email aloud through the global TTS queue (survives navigating away), or select any text in the reader / email body / browser and hit a floating ▶ to speak just that fragment.
- **Folder actions** — right-click a folder to *mark all read*, *delete read*, *empty Trash* or *delete all Spam*; bulk mark/delete from the selection bar.

### 🤖 AI assistant (local CLI)
Chat with a local AI — **Antigravity** (default), **Claude** or **Codex** CLI — your data is not sent to a third-party cloud:
- **Runs on your own login** — Antigravity (Google's `agy` CLI) answers per message via its `--print` mode using your existing Antigravity subscription; Claude runs as a live streaming session; Codex resumes its session. For Antigravity the full chat history is sent every turn, so it always remembers the conversation.
- **Pick the model** per engine in an editable config file (`ai-config.json`), or just ask the assistant to switch model — it rewrites the config and restarts itself. (A bad model self-heals back to the default.)
- **Reads notes on demand** — the assistant requests only the date/range it needs (`getNotes`), so it scales to any number of notes instead of stuffing them all into every prompt.
- **Controls the UI:** "go to this date", "open the every-day board", "expand fullscreen".
- **Creates, edits, sorts and deletes** notes & reminders by voice/text: "meeting the day after tomorrow at 9am", "rename this note", "mark it done", "put it in the Work folder".
- **Manages the folder trees** — it can create, rename, move (reparent) and delete folders on any board, and file one or many notes into them. It sees each board's tree (with ids) and every note's current folder.
- **Manages statuses** — it can create custom statuses (name + colour) and apply built-in or custom statuses to one or many notes. With the "everyday in calendar" toggle on, it also sees recurring everyday notes on the real dates they fall on and can mark a status for a **single day** (e.g. "mark the morning routine done for the 25th") without touching the other days.
- **Multi-step actions with feedback** — after it acts, the app sends the result back (the new id of anything created, or a failure reason), so it can chain dependent steps (e.g. *create a folder → file a note into it*) and report honestly instead of claiming success when something failed.
- **Four ways to respond** — a normal text reply, **speak** out loud, a **silent toast** near the clock, or a reply back to the **messenger** it was contacted from.
- **Knows the current date/time** and a 2-week date table — resolves "in a minute", "next Friday" correctly.
- **Controls your email too** — search, list and **open** mail (it reads the conversation back), then translate / summarize / read it aloud, and **mark read or delete** — e.g. *"open the last email from Medium, translate it and tell me the news in Russian"*. Email content is treated as **untrusted input**: the assistant is told (and a hard allow-list enforces) that it must never obey instructions embedded inside a message.
- **Mail watchers** — ask it to **watch a mailbox** ("follow this inbox; if something important arrives, ping me on Telegram and a toast"). It creates a watcher (also editable in Settings → *Mail watchers*) that, on its interval, fetches **only new mail** (a per-mailbox UID high-water mark — never re-scanning the whole box) and wakes the assistant to judge each arrival against your standing instruction and signal you.

### 💬 Telegram & images
- **Telegram bridge** — connect a bot token in Settings and chat with the assistant from Telegram (long-polling, works behind NAT, no public webhook). Replies — and reminders it scheduled from Telegram — go back to that chat; a **Disconnect** button clears the token.
  - *Creating the bot:* open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a username — it replies with a token like `12345:ABC…`. Paste that token into Settings → *Bots & messengers* → Telegram, then message your new bot. (Keep the token private; if it leaks, use `/revoke` in @BotFather and paste the new one.)
- **Image understanding** — send a photo (with a caption) from Telegram, or **paste / drag-and-drop / attach** an image in the in-app chat, and the assistant sees it (vision on Claude and Codex). Pasted images show removable thumbnail previews before sending.
- **Chat context persists** when you switch to Settings and back — cleared only when you clear it.

### 📆 Google Calendar (import, share & two-way sync)
- Connect one or more **Google accounts** in Settings → *Google Calendar*; tick which calendars to use. The **Appointments** tab (top bar) is an **infinite agenda** of your events grouped by day (today green, weekends red). Each event shows its **source** — `calendar · account` — an expandable body, and an **Import** button (one-time events go onto their day; recurring ones onto the **Every day** board). Already-imported events are flagged and skipped, so nothing duplicates.
- **Share a local note to Google** — in the note editor the **G** button (grey until linked, coloured once shared) pushes the note onto a calendar you can write to; shared notes get a small **G↑** badge. **Editing** a Google-linked note (time / title / text) — by hand or by the assistant — updates the event in Google; **deleting** it — whether you shared it or imported it from a calendar you can edit — offers to remove it from Google too. Read-only calendars are never modified. Events the app creates are tagged (`extendedProperties`) so another copy of the app (e.g. a partner sharing the calendar) can recognise them.
- **Auto-sync** — turn on the **⟳** toggle next to any calendar in Settings and pick a frequency (1 / 5 / 10 / 30 min, hourly, or daily). The app then pulls those calendars into notes on a timer — new events imported, changed events updated on the linked note. The **Sync** button (and the per-event ⟳ in the agenda) runs it on demand.
- **The assistant** can read (`listGoogleEvents`), import (`importGoogleEvents` — all, or one by title/id), and **create events on a shared calendar** (`addGoogleEvent`), e.g. *"add a shared task tomorrow at 3pm on the Family calendar"*. A periodic check is just a normal scheduled task.
  - *Setup (one-time):* in [Google Cloud Console](https://console.cloud.google.com/) create a project, enable the **Google Calendar API**, configure the **OAuth consent screen**, and create an **OAuth client ID** of type **Desktop app**. Paste the `client id` / `client secret` into `ai-config.json` (`googleClientId` / `googleClientSecret`, open it from Settings → *Assistant config file*) or, for distributed builds, into `.env` as `MAIN_VITE_GOOGLE_CLIENT_ID` / `MAIN_VITE_GOOGLE_CLIENT_SECRET`. Scopes used: `calendar.readonly` + `calendar.events` (read + create/edit events). Then **Connect Google account** and sign in in your browser.
  - *Note:* **Publish** the consent screen to **Production** so refresh tokens don't expire (Testing mode drops them after ~7 days). Unverified is fine for personal/shared use — users just see a one-time "Google hasn't verified this app" notice; full Google verification removes it but needs a review. The desktop `client secret` is **not** a real secret (Google's own model for installed apps — it's protected by PKCE + each user's own login).

### 🎙️ Voice input (speech-to-text)
- A **mic button** in the chat (next to **+**) **and in the note editor** (next to the fullscreen icon): **push-to-talk** — hold to record, release to transcribe. In the chat the text lands **at the cursor** in the prompt; in a note it's inserted **at the caret** — into the **title** if that field is focused, otherwise the body (or the end if no caret is set).
- Recognition is **fully local** via a small **sherpa-onnx** model **downloaded on first use from inside the app** (not bundled in the installer, so the `.exe` stays light). Enable it and pick the language (🇷🇺 / 🇬🇧) in Settings → Voice input.

### 🔊 Voice output (TTS)
- Three engines, switchable in Settings → Voice: **Piper** (bundled, offline, no Python; voices for **🇺🇦 / 🇷🇺 / 🇬🇧**), **Supertonic** (neural ONNX, multiple voices, model fetched on first use), or the **system Windows** voices (SAPI). Windows TTS picks a voice by language (falling back to the Russian voice for Ukrainian if none is installed).
- **Russian stress** — neural engines read with correct word stress (and ё) via bundled dictionaries (`resources/stress`): a base list, an ёfikator and hand-curated overrides, hot-reloaded so a fix applies without a restart.
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
- **Scheduled assistant tasks** — it (or you) schedules a task: **one-time** ("remind me in 30 min"), or **periodic** ("every hour", optionally within a **daily window** like 09:00–18:00). When it's due the assistant "wakes up" and acts (e.g. reads the morning agenda aloud, or nudges you to take a break). Each task remembers **where it was created** — a reminder set from Telegram is delivered back to Telegram, not spoken aloud. **Create and edit them by hand too** — in Settings (the "Assistant" tab) a form lets you write the task text, choose **one-time or periodic** with the time / interval, and pick **how it notifies you** when it fires: **by voice**, a **tray message**, or both (the assistant can set the same choice itself). Every task is listed with **edit (✎) / delete (×)**.

---

## 🧩 Stack

| Layer | Tech |
|-------|------|
| Shell | Electron 33 + electron-vite 5 + Vite 7 |
| UI | React 19 (plain JavaScript, **no TypeScript**) |
| Note editor | Tiptap (rich text → HTML, inline base64 images) |
| Storage | better-sqlite3 |
| Email | imapflow (IMAP), cached in SQLite |
| AI | local Antigravity (`agy --print`) / Claude (stream-json) / Codex CLI |
| Voice out | Piper (bundled) / Supertonic (ONNX, onnxruntime) / Windows SAPI |
| Voice in | sherpa-onnx (offline STT, model downloaded at runtime) |
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
- **Antigravity CLI** (`agy`, default) — install Antigravity and sign in with your Google account; the app drives it with your existing subscription.
- **Claude CLI** — install and log in.
- **Codex CLI** — install and log in.

If no CLI is found / signed in, the calendar and notes still work — the chat just shows a "not found" status.

---

## 📁 Structure

```
src/
  main/        # Electron main: window, tray, DB, reminders,
               #   AI engines (agy.js / claudeAgent.js / codex.js / chatLoop.js / prompt.js),
               #   email (mail.js / mailTool.js / mailWatch.js),
               #   TTS (tts.js / ttsServer.js / stress.js), STT (asr.js),
               #   task schedulers (aiTasks.js / mailWatch.js)
  preload/     # IPC bridge (window.api)
  renderer/    # React app (UI)
resources/
  tts/         # bundled Piper engine + voices (uk / ru / en)
  stress/      # Russian/Ukrainian word-stress dictionaries
  icon.png
```

---

## 🔒 Privacy

Notes and the database live **locally** on your machine (SQLite in `userData`).
Speech is synthesized **offline**. AI requests go through a local CLI that you
install and sign in to yourself.
