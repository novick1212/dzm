import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

type RenderRule = (
  tokens: Array<{ attrSet: (name: string, value: string) => void }>,
  idx: number,
  options: Record<string, unknown>,
  env: unknown,
  self: { renderToken: (tokens: unknown, idx: number, options: unknown) => string }
) => string

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`
  }
})

md.use(taskLists, { enabled: false, label: true })

const defaultLinkOpen: RenderRule =
  (md.renderer.rules.link_open as unknown as RenderRule) ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

const linkOpenRule = (tokens: any[], idx: number, options: any, env: any, self: any): string => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noreferrer noopener')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

md.renderer.rules.link_open = linkOpenRule as never

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), { ADD_ATTR: ['target', 'rel'] })
}

export function plainText(source: string): string {
  return source.replace(/[#>*_`~\-\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
}
