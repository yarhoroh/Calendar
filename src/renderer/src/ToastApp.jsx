import ReminderToasts from './components/ReminderToasts'

// Root for the separate notification window (#toast).
export default function ToastApp() {
  return <ReminderToasts onOpen={(dayKey) => window.api.notifyOpen?.(dayKey)} />
}
