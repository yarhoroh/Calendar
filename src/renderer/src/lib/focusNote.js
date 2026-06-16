import { createContext, useContext } from 'react'

// Holds the id of the note the cursor is "focusing" (hovered still for ~2s).
// When set, every other note blurs so the focused one reads clearly; any mouse
// movement clears it.
export const FocusNoteContext = createContext({ enabled: false, focusedId: null, setFocusedId: () => {} })

export const useFocusNote = () => useContext(FocusNoteContext)
