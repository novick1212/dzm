import './styles.css'
import { renderMarkdown } from './markdown'
import type { DzmConfig, Note } from './types'
import { DEFAULT_CONFIG } from './types'

const listEl = document.getElementById('list') as HTMLElement
const countEl = document.getElementById('count') as HTMLElement
const moreBtn = document.getElementById('more') as HTMLButtonElement
const searchWrap = document.getElementById('search-wrap') as HTMLElement
const searchInput = document.getElementById('search') as HTMLInputElement
const toastEl = document.getElementById('toast') as HTMLElement
const copySelBtn = document.getElementById('copy-selection') as HTMLButtonElement
const menuEl = document.getElementById('menu') as HTMLElement
const resizeEl = document.getElementById('resize') as HTMLElement
const searchToggle = document.getElementById('search-toggle') as HTMLButtonElement
const lockToggle = document.getElementById('lock-toggle') as HTMLButtonElement
const newNoteBtn = document.getElementById('new-note') as HTMLButtonElement
const hintEl = document.getElementById('hint') as HTMLElement

let cfg: DzmConfig = { ...DEFAULT_CONFIG }
let notes: Note[] = []
let editingId: string | null = null
let draft = ''
let dirty = false
let previewMode = false
let saving = false
let query = ''
let showAll = false
let unlocked = false
let unlockAt = 0
let dialogHold = false
const expandedIds = new Set<string>()
let saveTimer: number | null = null
let idleTimer: number | null = null
let toastTimer: number | null = null

function sorted(values: Note[]): Note[] {
  return [...values].sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    if (pinDiff !== 0) return pinDiff
    return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0
  })
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  const diff = (Date.now() - date.getTime()) / 1000
  if (diff < 45) return '刚刚'
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  if (today.toDateString() === date.toDateString()) return `今天 ${hm}`
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (yesterday.toDateString() === date.toDateString()) return `昨天 ${hm}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

function fullTime(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function applyTheme() {
  document.documentElement.dataset.theme = cfg.theme
  document.documentElement.style.setProperty('--panel-alpha', String(cfg.opacity || 0.95))
}

function visibleNotes(): Note[] {
  const filtered = query
    ? notes.filter((note) => note.body.toLowerCase().includes(query.toLowerCase()))
    : notes
  return showAll ? filtered : filtered.slice(0, cfg.maxVisible)
}

function render() {
  const filteredCount = query
    ? notes.filter((note) => note.body.toLowerCase().includes(query.toLowerCase())).length
    : notes.length
  const list = visibleNotes()

  listEl.replaceChildren()

  if (list.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.innerHTML = query
      ? '<div class="empty-title">没有匹配的便签</div>'
      : '<div class="empty-title">点右上角 + 新建便签</div><div class="empty-sub">支持 Markdown · 自动保存</div>'
    listEl.append(empty)
  }

  for (const note of list) {
    listEl.append(note.id === editingId ? editorCard(note) : readCard(note))
  }

  countEl.textContent = query
    ? `匹配 ${filteredCount} 条`
    : filteredCount === 0
      ? '空空如也'
      : list.length < filteredCount
        ? `共 ${filteredCount} 条 · 显示最新 ${list.length} 条`
        : `共 ${filteredCount} 条`

  const remaining = filteredCount - list.length
  moreBtn.hidden = remaining <= 0
  moreBtn.textContent = `更早 ${remaining} 条`
  if (editingId) {
    const card = listEl.querySelector('.note.editing')
    card?.scrollIntoView({ block: 'nearest' })
  }
}

function readCard(note: Note): HTMLElement {
  const article = document.createElement('article')
  article.className =
    'note' + (expandedIds.has(note.id) ? ' expanded' : '') + (note.pinned ? ' pinned' : '')
  article.dataset.id = note.id

  const head = document.createElement('div')
  head.className = 'note-head'
  const time = document.createElement('span')
  time.className = 'time'
  time.dataset.time = note.updated
  time.title = fullTime(note.updated)
  time.textContent = formatTime(note.updated)
  if (note.pinned) {
    const mark = document.createElement('span')
    mark.className = 'pin-mark'
    mark.title = '已置顶'
    time.prepend(mark)
  }
  head.append(time)

  const actions = document.createElement('div')
  actions.className = 'note-actions'
  const pinBtn = document.createElement('button')
  pinBtn.className = 'mini-btn pin-btn' + (note.pinned ? ' active' : '')
  pinBtn.textContent = note.pinned ? '取消置顶' : '置顶'
  pinBtn.title = note.pinned ? '取消置顶' : '置顶到列表顶部'
  pinBtn.setAttribute('aria-pressed', note.pinned ? 'true' : 'false')
  pinBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    void togglePin(note)
  })
  actions.append(pinBtn)
  const copyBtn = document.createElement('button')
  copyBtn.className = 'mini-btn'
  copyBtn.textContent = '复制'
  copyBtn.title = '复制 Markdown 原文'
  copyBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    void copyText(note.body, '已复制便签')
  })
  actions.append(copyBtn)
  head.append(actions)

  const body = document.createElement('div')
  body.className = 'note-body md'
  body.innerHTML = renderMarkdown(note.body || '_（空）_')

  article.append(head, body)
  article.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('a') || target.closest('button')) return
    if ((window.getSelection()?.toString() ?? '').length > 0) return
    if (unlocked) {
      void startEdit(note.id)
      return
    }
    if (expandedIds.has(note.id)) expandedIds.delete(note.id)
    else expandedIds.add(note.id)
    article.classList.toggle('expanded')
  })
  article.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    showMenu(event.clientX, event.clientY, [
      { label: note.pinned ? '取消置顶' : '置顶', action: () => void togglePin(note) },
      { label: '复制全文', action: () => void copyText(note.body, '已复制便签') },
      {
        label: '导出 .md',
        action: () => {
          dialogHold = true
          void window.dzm.exportNote(note.id).finally(() => {
            dialogHold = false
          })
        }
      },
      { label: '移到回收站', danger: true, action: () => void deleteNote(note.id) }
    ])
  })
  return article
}

function editorCard(note: Note): HTMLElement {
  const article = document.createElement('article')
  article.className = 'note editing'
  article.dataset.id = note.id

  const head = document.createElement('div')
  head.className = 'note-head drag'
  const time = document.createElement('span')
  time.className = 'time'
  time.dataset.time = note.updated
  time.textContent = editingLabel(note)
  head.append(time)

  const actions = document.createElement('div')
  actions.className = 'note-actions'
  const status = document.createElement('span')
  status.className = 'save-state'
  status.textContent = saving ? '保存中' : dirty ? '编辑中' : '已保存'
  actions.append(status)
  head.append(actions)

  const toolbar = document.createElement('div')
  toolbar.className = 'toolbar drag'
  const previewBtn = document.createElement('button')
  previewBtn.className = 'tool-btn'
  previewBtn.textContent = previewMode ? '源码' : '预览'
  previewBtn.title = 'Ctrl+E'
  previewBtn.addEventListener('click', () => {
    previewMode = !previewMode
    render()
    if (!previewMode) focusEditor()
  })
  const doneBtn = document.createElement('button')
  doneBtn.className = 'tool-btn primary'
  doneBtn.textContent = '完成'
  doneBtn.title = 'Ctrl+Enter'
  doneBtn.addEventListener('click', () => void lock())
  const delBtn = document.createElement('button')
  delBtn.className = 'tool-btn danger'
  delBtn.textContent = '删除'
  delBtn.addEventListener('click', () => void deleteNote(note.id))
  toolbar.append(previewBtn, doneBtn, delBtn)

  article.append(head, toolbar)

  if (previewMode) {
    const preview = document.createElement('div')
    preview.className = 'note-body md preview'
    preview.innerHTML = renderMarkdown(draft || '_（空）_')
    article.append(preview)
  } else {
    const editor = document.createElement('textarea')
    editor.className = 'editor'
    editor.value = draft
    editor.placeholder = '写点什么… 支持 Markdown，停止输入自动保存'
    editor.spellcheck = false
    editor.addEventListener('input', () => {
      draft = editor.value
      dirty = true
      autosize(editor)
      const state = article.querySelector('.save-state')
      if (state) state.textContent = '编辑中'
      scheduleSave()
      resetIdle()
    })
    editor.addEventListener('pointerdown', (event) => event.stopPropagation())
    article.append(editor)
    requestAnimationFrame(() => {
      autosize(editor)
    })
  }

  return article
}

function editingLabel(note: Note): string {
  return `${formatTime(note.updated)} · 编辑中`
}

function autosize(editor: HTMLTextAreaElement) {
  editor.style.height = 'auto'
  editor.style.height = `${Math.max(200, editor.scrollHeight)}px`
}

function focusEditor() {
  const editor = listEl.querySelector<HTMLTextAreaElement>('textarea.editor')
  if (!editor) return
  editor.focus()
  editor.setSelectionRange(editor.value.length, editor.value.length)
}

async function boot() {
  cfg = await window.dzm.getConfig()
  applyTheme()
  notes = sorted(await window.dzm.listNotes())
  setLockUi()
  render()

  window.dzm.onBlurred(() => {
    if (dialogHold) return
    if (Date.now() - unlockAt < 800) return
    if (unlocked) {
      void lock()
      return
    }
    if (editingId) void exitEdit()
    if (!searchWrap.hidden) closeSearch()
    hideMenu()
  })
  window.dzm.onNewNote(() => void newNote())
  window.dzm.onSearch(() => void openSearch())
  window.dzm.onConfigChanged((next) => {
    cfg = next
    applyTheme()
    render()
  })

  window.setInterval(() => {
    const editingNote = editingId ? notes.find((item) => item.id === editingId) : null
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-time]'))) {
      if (el.closest('.note.editing')) {
        if (editingNote) el.textContent = editingLabel(editingNote)
        continue
      }
      el.textContent = formatTime(el.dataset.time ?? new Date().toISOString())
    }
  }, 30_000)
}

function setLockUi() {
  document.body.classList.toggle('is-unlocked', unlocked)
  hintEl.textContent = unlocked ? '已解锁' : '已锁定'
  lockToggle.title = unlocked ? '锁定并回到桌面' : '解锁编辑'
  lockToggle.setAttribute('aria-pressed', unlocked ? 'true' : 'false')
}

async function unlock() {
  if (unlocked) return
  unlocked = true
  unlockAt = Date.now()
  expandedIds.clear()
  setLockUi()
  render()
  await window.dzm.lift()
}

async function lock() {
  if (!unlocked) return
  await exitEdit()
  unlocked = false
  closeSearch(false)
  expandedIds.clear()
  setLockUi()
  render()
  await window.dzm.sink()
}

async function startEdit(id: string) {
  if (editingId === id) return
  if (!unlocked) await unlock()
  if (editingId) await flushSave()
  const note = notes.find((item) => item.id === id)
  if (!note) return
  if (!searchWrap.hidden) {
    searchWrap.hidden = true
    searchInput.value = ''
    query = ''
  }
  editingId = id
  draft = note.body
  dirty = false
  previewMode = false
  copySelBtn.hidden = true
  document.body.classList.add('is-editing')
  render()
  resetIdle()
  focusEditor()
  window.setTimeout(focusEditor, 120)
  window.setTimeout(focusEditor, 320)
}

async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!editingId || !dirty) return
  const id = editingId
  const body = draft
  dirty = false
  saving = true
  updateSaveState('保存中')
  try {
    const updated = await window.dzm.updateNote(id, body)
    const index = notes.findIndex((item) => item.id === id)
    if (index >= 0) notes[index] = updated
    updateSaveState('已保存')
  } catch (err) {
    console.error(err)
    dirty = true
    updateSaveState('保存失败')
  } finally {
    saving = false
  }
}

function updateSaveState(text: string) {
  const state = listEl.querySelector('.note.editing .save-state')
  if (state) state.textContent = text
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushSave(), 600)
}

async function exitEdit() {
  if (!editingId) return
  const id = editingId
  const empty = draft.trim().length === 0
  await flushSave()
  if (empty) {
    await window.dzm.deleteNote(id)
    notes = notes.filter((item) => item.id !== id)
  }
  editingId = null
  draft = ''
  dirty = false
  previewMode = false
  document.body.classList.remove('is-editing')
  clearIdle()
  notes = sorted(notes)
  render()
}

async function newNote() {
  if (editingId) await flushSave()
  if (!searchWrap.hidden) closeSearch(false)
  if (!unlocked) await unlock()
  const note = await window.dzm.createNote('')
  notes = sorted([note, ...notes])
  showAll = false
  await startEdit(note.id)
}

async function deleteNote(id: string) {
  if (editingId === id) {
    editingId = null
    draft = ''
    dirty = false
    previewMode = false
    document.body.classList.remove('is-editing')
    clearIdle()
  }
  const token = await window.dzm.deleteNote(id)
  notes = notes.filter((item) => item.id !== id)
  render()
  if (token) {
    showToast('已移到回收站', '撤销', async () => {
      await window.dzm.undoDelete(token)
      notes = sorted(await window.dzm.listNotes())
      render()
    })
  }
}

async function togglePin(note: Note) {
  const next = !note.pinned
  try {
    const updated = await window.dzm.setPinned(note.id, next)
    const index = notes.findIndex((item) => item.id === updated.id)
    if (index >= 0) notes[index] = updated
    notes = sorted(notes)
    render()
    showToast(next ? '已置顶' : '已取消置顶')
  } catch (err) {
    console.error(err)
    showToast('置顶失败')
  }
}

async function copyText(text: string, message: string) {
  await window.dzm.copyText(text)
  showToast(message)
}

function showToast(message: string, actionLabel?: string, action?: () => void) {
  toastEl.replaceChildren()
  const span = document.createElement('span')
  span.textContent = message
  toastEl.append(span)
  if (actionLabel && action) {
    const btn = document.createElement('button')
    btn.textContent = actionLabel
    btn.className = 'toast-action'
    btn.addEventListener('click', () => {
      action()
      hideToast()
    })
    toastEl.append(btn)
  }
  toastEl.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => hideToast(), 5000)
}

function hideToast() {
  toastEl.hidden = true
}

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  if (!editingId) return
  idleTimer = window.setTimeout(() => {
    void lock()
  }, Math.max(10_000, cfg.lockAfterMs))
}

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

async function openSearch() {
  if (!searchWrap.hidden) {
    searchInput.focus()
    searchInput.select()
    return
  }
  searchWrap.hidden = false
  await window.dzm.lift()
  searchInput.focus()
  searchInput.select()
}

function closeSearch(sink = true) {
  const wasOpen = !searchWrap.hidden
  searchWrap.hidden = true
  searchInput.value = ''
  query = ''
  render()
  if (sink && wasOpen && !editingId && !unlocked) void window.dzm.sink()
}

function showMenu(x: number, y: number, items: Array<{ label: string; danger?: boolean; action: () => void }>) {
  menuEl.replaceChildren()
  for (const item of items) {
    const btn = document.createElement('button')
    btn.className = 'menu-item' + (item.danger ? ' danger' : '')
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      hideMenu()
      item.action()
    })
    menuEl.append(btn)
  }
  menuEl.hidden = false
  const rect = menuEl.getBoundingClientRect()
  const maxX = window.innerWidth - rect.width - 6
  const maxY = window.innerHeight - rect.height - 6
  menuEl.style.left = `${Math.min(x, maxX)}px`
  menuEl.style.top = `${Math.min(y, maxY)}px`
}

function hideMenu() {
  menuEl.hidden = true
}

function moveSelectionCopyButton() {
  const selection = window.getSelection()
  const text = selection?.toString() ?? ''
  if (!text.trim() || editingId || selection!.rangeCount === 0) {
    copySelBtn.hidden = true
    return
  }
  const range = selection!.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    copySelBtn.hidden = true
    return
  }
  copySelBtn.hidden = false
  const left = Math.min(rect.right + 6, window.innerWidth - 56)
  const top = Math.min(rect.bottom + 6, window.innerHeight - 30)
  copySelBtn.style.left = `${Math.max(6, left)}px`
  copySelBtn.style.top = `${Math.max(6, top)}px`
}

document.addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement).closest('a')
  if (anchor) {
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:/i.test(href)) void window.dzm.openExternal(href)
    return
  }
  if (!menuEl.hidden && !(event.target as HTMLElement).closest('.menu')) hideMenu()
})

document.addEventListener('contextmenu', (event) => {
  if (!(event.target as HTMLElement).closest('.note')) {
    event.preventDefault()
  }
})

document.addEventListener('mouseup', () => {
  moveSelectionCopyButton()
})

document.addEventListener('mousedown', (event) => {
  if (!(event.target as HTMLElement).closest('#copy-selection')) copySelBtn.hidden = true
  if (!(event.target as HTMLElement).closest('.menu')) hideMenu()
})

document.addEventListener('keydown', (event) => {
  if (event.isComposing) return
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()

  if (mod && key === 'f') {
    event.preventDefault()
    if (searchWrap.hidden) openSearch()
    else closeSearch()
    return
  }
  if (mod && key === 'n') {
    event.preventDefault()
    void newNote()
    return
  }
  if (mod && key === 's') {
    event.preventDefault()
    void flushSave().then(() => showToast('已保存'))
    return
  }
  if (editingId && mod && key === 'e') {
    event.preventDefault()
    previewMode = !previewMode
    render()
    if (!previewMode) focusEditor()
    return
  }
  if (editingId && mod && event.key === 'Enter') {
    event.preventDefault()
    void lock()
    return
  }
  if (event.key === 'Escape') {
    if (!menuEl.hidden) {
      hideMenu()
      return
    }
    if (editingId) {
      event.preventDefault()
      void lock()
      return
    }
    if (!toastEl.hidden) {
      hideToast()
      return
    }
    if (!searchWrap.hidden) {
      closeSearch()
      return
    }
    if (unlocked) {
      event.preventDefault()
      void lock()
    }
  }
  if (editingId) resetIdle()
})

newNoteBtn.addEventListener('click', () => void newNote())

lockToggle.addEventListener('click', () => {
  if (unlocked) void lock()
  else void unlock()
})

searchToggle.addEventListener('click', () => {
  if (searchWrap.hidden) openSearch()
  else closeSearch()
})

searchInput.addEventListener('input', () => {
  query = searchInput.value.trim()
  showAll = false
  render()
})

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
  }
})

moreBtn.addEventListener('click', () => {
  showAll = true
  render()
})

copySelBtn.addEventListener('click', () => {
  const text = window.getSelection()?.toString() ?? ''
  if (text.trim()) void copyText(text, '已复制选中内容')
  copySelBtn.hidden = true
})

type ResizeGesture = {
  startX: number
  startY: number
  x: number
  y: number
  raf: number
}

let resizeGesture: ResizeGesture | null = null

function endResize() {
  if (!resizeGesture) return
  if (resizeGesture.raf) cancelAnimationFrame(resizeGesture.raf)
  window.dzm.resizeMove(resizeGesture.x - resizeGesture.startX, resizeGesture.y - resizeGesture.startY)
  window.dzm.resizeEnd()
  resizeGesture = null
}

window.addEventListener('pointermove', (event) => {
  if (!resizeGesture) return
  resizeGesture.x = event.screenX
  resizeGesture.y = event.screenY
  if (resizeGesture.raf) return
  resizeGesture.raf = requestAnimationFrame(() => {
    if (!resizeGesture) return
    resizeGesture.raf = 0
    window.dzm.resizeMove(resizeGesture.x - resizeGesture.startX, resizeGesture.y - resizeGesture.startY)
  })
})

window.addEventListener('pointerup', endResize)
window.addEventListener('pointercancel', endResize)
window.addEventListener('blur', endResize)

resizeEl.addEventListener('pointerdown', (event) => {
  if (!unlocked || event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  resizeEl.setPointerCapture(event.pointerId)
  resizeGesture = { startX: event.screenX, startY: event.screenY, x: event.screenX, y: event.screenY, raf: 0 }
  window.dzm.resizeStart()
})

listEl.addEventListener('scroll', () => {
  copySelBtn.hidden = true
  hideMenu()
})

void boot()
