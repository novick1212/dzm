import type { Note } from '../src/types'

/**
 * Outbound seam for a remote copy of the notes folder.
 *
 * The store keeps writing local files first and only reports the change
 * afterwards, so a provider must never block or throw. A provider that owns a
 * synced folder (NAS mount, WebDAV mount, Syncthing) usually does nothing here;
 * a provider that talks to an HTTP API mirrors the same calls upstream.
 *
 * Inbound changes are intentionally out of scope for now: folder-based sync
 * writes note files directly, and an API provider will get a pull/merge hook
 * together with its conflict rules.
 */
export interface SyncProvider {
  noteSaved(note: Note): void
  noteDeleted(id: string): void
}
