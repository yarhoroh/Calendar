import { createContext, useContext } from 'react'

// Shared by the calendar board and the note lists/items inside it:
//   visibleIds — Set of folder ids to show, or null = show everything (General)
//   names      — { folderId: name } to label a note with its immediate folder
//   activeId   — currently selected folder id (null = General root); new notes
//                created while a folder is selected are filed into it
export const FolderFilterContext = createContext({ visibleIds: null, names: {}, activeId: null })

export const useFolderFilter = () => useContext(FolderFilterContext)
