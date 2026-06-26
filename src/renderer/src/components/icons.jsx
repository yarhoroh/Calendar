// All SVG glyphs live here as small components so they can be reused and
// swapped in one place. Every icon inherits color via `currentColor`.

export function MinimizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11">
      <line x1="1" y1="5.5" x2="10" y2="5.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

export function MaximizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="1" y="1" width="9" height="9" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

export function RestoreIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="1" y="3" width="6" height="6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 3V1.5h6.5V8H8" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11">
      <line x1="1" y1="1" x2="10" y2="10" stroke="currentColor" strokeWidth="1.1" />
      <line x1="10" y1="1" x2="1" y2="10" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

export function SunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4.5" />
      <path
        d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.4 4.4l2.1 2.1M17.5 17.5l2.1 2.1M19.6 4.4l-2.1 2.1M6.5 17.5l-2.1 2.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

export function GoogleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.5 29.5 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.5 29.5 4.5 24 4.5 16.3 4.5 9.7 8.9 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 43.5c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 34.5 26.7 35.5 24 35.5c-5.3 0-9.7-3.1-11.3-7.6l-6.5 5C9.6 39 16.2 43.5 24 43.5z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.3 5.3C39.9 36.6 43.5 31 43.5 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  )
}

export function AppointmentsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
      <path d="M9 16l2 2 4-4" />
    </svg>
  )
}

export function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 6l-10 7L2 6" />
    </svg>
  )
}

// --- mail folder icons (16px, stroke) ---
const folderSvg = (children) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)
export const InboxIcon = () => folderSvg(<>
  <path d="M22 12h-6l-2 3h-4l-2-3H2" />
  <path d="M5.5 5.5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6L5.5 5.5z" />
</>)
export const SentIcon = () => folderSvg(<><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></>)
export const TrashIcon = () => folderSvg(<><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v5M14 11v5" /></>)
export const SpamIcon = () => folderSvg(<><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>)
export const DraftIcon = () => folderSvg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></>)
export const StarIcon = () => folderSvg(<path d="M12 2l3 7 7 .5-5.5 4.5 2 7L12 17l-6.5 4 2-7L2 9.5 9 9z" />)
// Gmail "important" marker (label_important). filled = important (yellow), outline = not.
export const ImportantIcon = ({ filled }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 18.99l11 .01c.67 0 1.27-.33 1.63-.84L21 12l-4.37-6.16c-.36-.51-.96-.84-1.63-.84l-11 .01L8 12l-4.5 6.99z" />
  </svg>
)
export const ArchiveIcon = () => folderSvg(<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></>)
export const LabelIcon = () => folderSvg(<><path d="M20 12l-8 8-9-9V3h8l9 9z" /><circle cx="7" cy="7" r="1.3" /></>)
export const SearchIcon = () => folderSvg(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>)
export const ZoomInIcon = () => folderSvg(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /><path d="M11 8v6" /><path d="M8 11h6" /></>)
export const ZoomOutIcon = () => folderSvg(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /><path d="M8 11h6" /></>)
// translate/language (globe), shorten (decreasing lines) and apply (check) — for the
// internal browser's compact toolbar (icon → dropdown / action)
export const LanguageIcon = () => folderSvg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.4 2.5 15.6 0 18" /><path d="M12 3c-2.5 2.4-2.5 15.6 0 18" /></>)
export const ShortenIcon = () => folderSvg(<><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h6" /></>)
export const ApplyIcon = () => folderSvg(<path d="M20 6L9 17l-5-5" />)
// compose / new email — a pencil
export const ComposeIcon = () => folderSvg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></>)
export const AlignLeftIcon = () => folderSvg(<><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></>)
export const AlignCenterIcon = () => folderSvg(<><path d="M4 6h16" /><path d="M7 12h10" /><path d="M5 18h14" /></>)
export const AlignRightIcon = () => folderSvg(<><path d="M4 6h16" /><path d="M10 12h10" /><path d="M7 18h13" /></>)
export const RefreshIcon = () => folderSvg(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>)
export const ColumnsIcon = () => folderSvg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M13 4v16" /></>)
export const ReplyIcon = () => folderSvg(<><path d="M9 17l-5-5 5-5" /><path d="M4 12h11a5 5 0 0 1 5 5v1" /></>)
export const ReplyAllIcon = () => folderSvg(<><path d="M7 17l-5-5 5-5" /><path d="M12 17l-5-5 5-5" /><path d="M7 12h9a5 5 0 0 1 5 5v1" /></>)
export const ForwardIcon = () => folderSvg(<><path d="M15 17l5-5-5-5" /><path d="M20 12H9a5 5 0 0 0-5 5v1" /></>)
export const DownloadIcon = () => folderSvg(<><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 21h14" /></>)
// the colourful Gmail logo (brand colours, not currentColor)
export function GmailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#4caf50" d="M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z" />
      <path fill="#1e88e5" d="M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8C4.924,8,3,9.924,3,12.298z" />
      <path fill="#fbc02d" d="M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8C43.076,8,45,9.924,45,12.298z" />
    </svg>
  )
}

export function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

export function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

export function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

export function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  )
}

export function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
    </svg>
  )
}

export function PlayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

export function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </svg>
  )
}

export function NextIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5v14l8.5-7z" />
      <rect x="16" y="5" width="3" height="14" rx="1.3" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

export function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 3v2l-1 1v5l3 3v2h-5v6h-2v-6H6v-2l3-3V6L8 5V3h8z" />
    </svg>
  )
}
