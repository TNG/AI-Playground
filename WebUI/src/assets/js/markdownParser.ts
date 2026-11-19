import { Marked, Token, Tokens, RendererThis } from 'marked'
import hljs from 'highlight.js'
import { stringToBase64 } from 'uint8array-extras'

import 'highlight.js/styles/github-dark-dimmed.css'

const startMarker = '===ORIGINALCODE'
const endMarker = 'ENDOFORIGINALCODE==='
const replaceRegex = new RegExp(`${startMarker}(.*?)${endMarker}`, 'gs')

const codeRenderer = {
  renderer: {
    code(token: Tokens.Code) {
      const lang = token.lang || 'plaintext'
      const code = token.text
      const language = hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(code, { language }).value

      return `<div class=" rounded-md my-4 code-section">
        <div class="flex justify-between items-center sticky -top-4 text-white bg-gray-800 px-4 py-2 text-xs rounded-t-md">
          <span>${language.toUpperCase()}</span>
          <button class="hidden flex items-center justify-end copy-code" ${startMarker}${code}${endMarker}>
            <span class="svg-icon i-copy w-4 h-4 mr-1 pointer-events-none"></span><span class="pointer-events-none">Copy</span>
          </button>
        </div>
        <pre class="hljs"><code class="hljs">${highlighted}</code></pre>
      </div>`
    },
  },
}

/**
 * Raw HTML the assistant may emit without being escaped, so raw links and
 * underline wrappers render like their markdown equivalents. DOMPurify still
 * sanitizes whatever passes through here.
 */
const allowedUnderlineTag = /^<\/?(?:u|ins)\s*>$/i
const allowedClosingAnchor = /^<\/a>\s*$/i
const allowedOpeningAnchor =
  /^<a\s+href="([^"<>]*)"((?:\s+(?:title|target|rel)="[^"<>]*")*\s*)>\s*$/i

const htmlEscaper = {
  walkTokens: (token: Token) => {
    if (token.type !== 'html') return
    try {
      if (allowedClosingAnchor.test(token.raw) || allowedUnderlineTag.test(token.raw)) return
      const anchor = allowedOpeningAnchor.exec(token.raw)
      if (anchor) {
        const href = cleanUrl(anchor[1])
        if (href !== null) {
          token.text = `<a href="${escapeHtml(href)}"${anchor[2]}>`
          return
        }
      }
      token.text = token.raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    } catch (error) {
      console.error('error while html escaping', { error, token })
    }
  },
}

const externalLinkIcon =
  ' <span class="svg-icon i-external-link external-link-icon" aria-hidden="true"></span>'

const cleanUrl = (href: string): string | null => {
  try {
    return encodeURI(href).replace(/%25/g, '%')
  } catch {
    return null
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const linkRenderer = {
  renderer: {
    link(this: RendererThis, token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens)
      const href = cleanUrl(token.href)
      if (href === null) return text
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      const isWeb = /^https?:\/\//i.test(href)
      return `<a href="${escapeHtml(href)}"${title}>${text}${isWeb ? externalLinkIcon : ''}</a>`
    },
  },
}

const dataCodeFixer = (input: string) => {
  try {
    if (input.includes(startMarker) && input.includes(endMarker)) {
      return input.replace(replaceRegex, (_, data) => {
        return `data-code="${stringToBase64(data)}"`
      })
    }
    return input
  } catch (error) {
    console.error('error while data code encoding', { error, input })
    throw error
  }
}

/**
 * Adds the external-link icon to web anchors the assistant wrote as raw HTML,
 * so they look the same as markdown links. Anchors rendered by linkRenderer
 * already contain the icon, so those are left unchanged. Must run after
 * dataCodeFixer, which base64-encodes code-block content out of the way.
 */
const rawAnchorIconFixer = (input: string) => {
  return input.replace(
    /(<a\s+href="https?:[^"]*"(?:\s+(?:title|target|rel)="[^"]*")*\s*>)([\s\S]*?)(<\/a>)/gi,
    (match, open: string, inner: string, close: string) =>
      inner.includes('external-link-icon') ? match : `${open}${inner}${externalLinkIcon}${close}`,
  )
}

export const parser = new Marked({
  pedantic: false,
  gfm: true,
  breaks: true,
  async: false,
})
  .use(codeRenderer)
  .use(htmlEscaper)
  .use(linkRenderer)
  .use({
    hooks: {
      postprocess: (html: string) => rawAnchorIconFixer(dataCodeFixer(html)),
    },
  })

export const plainParser = new Marked({
  pedantic: false,
  gfm: true,
  breaks: true,
  async: false,
})
  .use(htmlEscaper)
  .use(linkRenderer)
  .use({
    hooks: {
      postprocess: rawAnchorIconFixer,
    },
  })

export const parse = (input: string) => {
  try {
    return parser.parse(input)
  } catch (error) {
    console.error('error while parsing', { error, input })
  }

  try {
    return plainParser.parse(input)
  } catch (error) {
    console.error('error while plain parsing', { error, input })
    return input
  }
}
