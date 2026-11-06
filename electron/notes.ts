import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Note } from '../src/types'
import type { SyncProvider } from './sync'

interface ParsedFile {
  note: Note
  file: string
}

export class NotesStore {
  readonly dir: string
  private readonly trashDir: string
  private sync: SyncProvider | null = null

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'notes')
    this.trashDir = path.join(this.dir, '.trash')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.trashDir, { recursive: true })
  }

  setSyncProvider(provider: SyncProvider | null): void {
    this.sync = provider
  }

  list(): Note[] {
    const files = fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)

    const notes: Note[] = []
    for (const file of files) {
      const parsed = this.readFile(path.join(this.dir, file), file)
      if (parsed) notes.push(parsed.note)
    }
    notes.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    return notes
  }

  create(body = ''): Note {
    const now = new Date().toISOString()
    const note: Note = {
      id: crypto.randomBytes(4).toString('hex'),
      created: now,
      updated: now,
      body
    }
    this.writeFile(this.fileFor(note), note)
    this.notifySaved(note)
    return note
  }

  update(id: string, body: string): Note {
    const found = this.find(id)
    if (!found) throw new Error(`note not found: ${id}`)
    const note: Note = { ...found.note, body, updated: new Date().toISOString() }
    this.writeFile(this.fileFor(found.note), note)
    this.notifySaved(note)
    return note
  }

  setPinned(id: string, pinned: boolean): Note {
    const found = this.find(id)
    if (!found) throw new Error(`note not found: ${id}`)
    const note: Note = { ...found.note, pinned }
    this.writeFile(this.fileFor(found.note), note)
    this.notifySaved(note)
    return note
  }

  remove(id: string): string | null {
    const found = this.find(id)
    if (!found) return null
    const source = path.join(this.dir, found.file)
    const token = `${Date.now()}__${found.file}`
    fs.renameSync(source, path.join(this.trashDir, token))
    this.notifyDeleted(found.note.id)
    return token
  }

  restore(token: string): boolean {
    const source = path.join(this.trashDir, token)
    if (!fs.existsSync(source)) return false
    const name = token.slice(token.indexOf('__') + 2)
    const target = path.join(this.dir, name)
    fs.renameSync(source, target)
    const restored = this.readFile(target, name)
    if (restored) this.notifySaved(restored.note)
    return true
  }

  get(id: string): Note | null {
    return this.find(id)?.note ?? null
  }

  private find(id: string): ParsedFile | null {
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const file = path.join(this.dir, entry.name)
      const parsed = this.readFile(file, entry.name)
      if (parsed && parsed.note.id === id) return parsed
    }
    return null
  }

  private fileFor(note: Note): string {
    const existing = this.find(note.id)
    if (existing) return path.join(this.dir, existing.file)
    const stamp = note.created.replace(/[:.]/g, '-').slice(0, 19)
    return path.join(this.dir, `${stamp}__${note.id}.md`)
  }

  private readFile(fullPath: string, name: string): ParsedFile | null {
    let raw: string
    try {
      raw = fs.readFileSync(fullPath, 'utf8')
    } catch {
      return null
    }
    const stat = fs.statSync(fullPath)
    const { meta, body } = splitFrontmatter(raw)
    const fallback = stat.mtime.toISOString()
    return {
      file: name,
      note: {
        id: meta.id || name.replace(/\.md$/, '').split('__').pop() || name,
        created: meta.created || fallback,
        updated: meta.updated || fallback,
        body,
        pinned: meta.pinned === 'true'
      }
    }
  }

  private notifySaved(note: Note): void {
    try {
      this.sync?.noteSaved(note)
    } catch (error) {
      console.error('[sync] noteSaved failed', error)
    }
  }

  private notifyDeleted(id: string): void {
    try {
      this.sync?.noteDeleted(id)
    } catch (error) {
      console.error('[sync] noteDeleted failed', error)
    }
  }

  private writeFile(fullPath: string, note: Note): void {
    const pinned = note.pinned ? '\npinned: true' : ''
    const content = `---\nid: ${note.id}\ncreated: ${note.created}\nupdated: ${note.updated}${pinned}\n---\n${note.body}`
    const tmp = `${fullPath}.tmp`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, fullPath)
  }
}

function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { meta, body: raw.slice(match[0].length) }
}
