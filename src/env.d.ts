import type { DzmApi } from '../electron/preload'

declare global {
  interface Window {
    dzm: DzmApi
  }
}

export {}
