import { useEffect, useState } from 'react'
import api from '../lib/api'

// Surfaces a pending Telegram pairing request (an unrecognized chat messaged the
// bot) as local state so App can show a confirm dialog. The AI never sees the
// message until the user approves it here.
export function useTelegramPairing() {
  const [pending, setPending] = useState(null)

  useEffect(() => {
    const off = api.onTelegramPairingRequest?.((req) => setPending(req))
    return () => off?.()
  }, [])

  const approve = async () => {
    await api.approveTelegramPairing?.()
    setPending(null)
  }
  const reject = async () => {
    await api.rejectTelegramPairing?.()
    setPending(null)
  }

  return { pending, approve, reject }
}
