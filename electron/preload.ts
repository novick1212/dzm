import { contextBridge, ipcRenderer } from 'electron'
import type { DzmConfig, Note } from '../src/types'

const api = {
  listNotes: (): Promise<Note[]> => ipcRenderer.invoke('notes:list'),
  createNote: (body: string): Promise<Note> => ipcRenderer.invoke('notes:create', body),
  updateNote: (id: string, body: string): Promise<Note> => ipcRenderer.invoke('notes:update', { id, body }),
  setPinned: (id: string, pinned: boolean): Promise<Note> => ipcRenderer.invoke('notes:pin', { id, pinned }),
  deleteNote: (id: string): Promise<string | null> => ipcRenderer.invoke('notes:delete', id),
  undoDelete: (token: string): Promise<boolean> => ipcRenderer.invoke('notes:undo-delete', token),
  exportNote: (id: string): Promise<string | null> => ipcRenderer.invoke('notes:export', id),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  openDataDir: (): Promise<void> => ipcRenderer.invoke('app:open-data-dir'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
  getConfig: (): Promise<DzmConfig> => ipcRenderer.invoke('config:get'),
  patchConfig: (partial: Partial<DzmConfig>): Promise<DzmConfig> => ipcRenderer.invoke('config:patch', partial),
  lift: (options?: { cancelIfPointerOutside?: boolean }): Promise<number> => ipcRenderer.invoke('window:lift', options),
  sink: (): Promise<void> => ipcRenderer.invoke('window:sink'),
  resizeStart: () => ipcRenderer.send('window:resize-start'),
  resizeMove: (dx: number, dy: number) => ipcRenderer.send('window:resize-move', dx, dy),
  resizeEnd: () => ipcRenderer.send('window:resize-end'),
  onBlurred: (cb: () => void) => {
    ipcRenderer.on('window:blurred', () => cb())
  },
  onNewNote: (cb: () => void) => {
    ipcRenderer.on('shortcut:new-note', () => cb())
  },
  onSearch: (cb: () => void) => {
    ipcRenderer.on('shortcut:search', () => cb())
  },
  onToggleVisible: (cb: () => void) => {
    ipcRenderer.on('shortcut:toggle-visible', () => cb())
  },
  onConfigChanged: (cb: (cfg: DzmConfig) => void) => {
    ipcRenderer.on('config:changed', (_e, cfg: DzmConfig) => cb(cfg))
  }
}

contextBridge.exposeInMainWorld('dzm', api)

export type DzmApi = typeof api
