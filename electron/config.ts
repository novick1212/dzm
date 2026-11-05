import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG, type DzmConfig } from '../src/types'

export class ConfigStore {
  private file: string
  private data: DzmConfig

  constructor(baseDir: string) {
    this.file = path.join(baseDir, 'config.json')
    let stored: Partial<DzmConfig> = {}
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      stored = {}
    }
    this.data = { ...DEFAULT_CONFIG, ...stored }
  }

  get(): DzmConfig {
    return { ...this.data }
  }

  patch(partial: Partial<DzmConfig>): DzmConfig {
    this.data = { ...this.data, ...partial }
    this.flush()
    return this.get()
  }

  flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch (err) {
      console.error('[config] write failed:', err)
    }
  }
}
