import { createContext, useContext } from 'react'

// When enabled (and the calendar is the active board), everyday notes that have
// explicit weekday `days` are projected (read-only) into the matching day
// columns. `items` is the everyday-board note list; `openEveryday` jumps to it.
export const EverydayProjectionContext = createContext({
  enabled: false,
  items: [],
  workingDays: [],
  update: () => {},
  remove: () => {},
  openEveryday: () => {}
})

export const useEverydayProjection = () => useContext(EverydayProjectionContext)
