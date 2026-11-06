export interface Note {
  id: string
  created: string
  updated: string
  body: string
  pinned?: boolean
}
export interface DzmConfig {
  theme: 'paper' | 'ink' | 'mist'
  opacity: number
  lockAfterMs: number
  maxVisible: number
  bounds: { x: number; y: number; width: number; height: number } | null
  autostart: boolean
  embedDesktop: boolean
}

export const DEFAULT_CONFIG: DzmConfig = {
  theme: 'paper',
  opacity: 0.95,
  lockAfterMs: 60_000,
  maxVisible: 5,
  bounds: null,
  autostart: false,
  embedDesktop: true
}
