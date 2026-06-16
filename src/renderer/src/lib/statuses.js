import { createContext, useContext } from 'react'

// Built-in statuses are fixed (special colours / icons / strike-through live in
// code). Custom statuses are user-defined (name + colour), stored in the DB and
// added on top. A note's `status` is either a built-in key or a custom id.
export const BUILTIN_STATUSES = ['todo', 'doing', 'done'] // selectable in the menu
export const BUILTIN_SET = new Set(['todo', 'doing', 'done', 'cancelled'])

// custom status list, provided where notes render so each item/menu can resolve
// a status id to its name/colour without its own IPC subscription
export const CustomStatusesContext = createContext([])
export const useCustomStatuses = () => useContext(CustomStatusesContext)
