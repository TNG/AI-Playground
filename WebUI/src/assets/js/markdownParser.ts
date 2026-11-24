import { Marked, Token, Tokens, RendererThis } from 'marked'
import hljs from 'highlight.js'
import { stringToBase64 } from 'uint8array-extras'

import { MARKDOWN_ALLOWED_TAGS } from '@/lib/sanitize'

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
 * Raw HTML the assistant emits is passed through unescaped when every tag in it
 * is on the sanitizer's allowlist, so raw formatting (bold, links, underline,
 * …) renders like its markdown equivalent. Anything else stays escaped, and
 * DOMPurify still sanitizes whatever passes through here.
 */
const rawHtmlTagChunk = /<[^<>]*>/g
const rawHtmlTagName = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/

const isAllowedRawHtml = (raw: string): boolean => {
  const chunks = raw.match(rawHtmlTagChunk)
  if (chunks === null) return false
  const outside = raw.replace(rawHtmlTagChunk, '')
  if (outside.includes('<') || outside.includes('>')) return false
  return chunks.every((chunk) => {
    const name = rawHtmlTagName.exec(chunk)?.[1]?.toLowerCase()
    return name !== undefined && MARKDOWN_ALLOWED_TAGS.includes(name)
  })
}

/** The anchor shape whose href gets normalized like a markdown link's href. */
const allowedOpeningAnchor =
  /^<a\s+href="([^"<>]*)"((?:\s+(?:title|target|rel)="[^"<>]*")*\s*)>\s*$/i

const escapeRawHtml = (raw: string) =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const htmlEscaper = {
  walkTokens: (token: Token) => {
    if (token.type !== 'html') return
    try {
      if (isAllowedRawHtml(token.raw)) {
        const anchor = allowedOpeningAnchor.exec(token.raw)
        if (anchor) {
          const href = cleanUrl(anchor[1])
          if (href !== null) {
            token.text = `<a href="${escapeHtml(href)}"${anchor[2]}>`
            return
          }
        } else {
          return
        }
      }
      token.text = escapeRawHtml(token.raw)
    } catch (error) {
      console.error('error while html escaping', { error, token })
    }
  },
}

const externalLinkIcon =
  ' <span class="svg-icon i-external-link external-link-icon" aria-hidden="true"></span>'

/** The href a created-file mention carries; rendered as a chip button, never as an anchor. */
const FILE_LINK_HREF = 'aipg-file:'

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
      if (token.href.startsWith(FILE_LINK_HREF)) {
        const filePath = decodeURIComponent(token.href.slice(FILE_LINK_HREF.length))
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<button class="file-link" data-file-path="${escapeHtml(filePath)}"${title}><span class="svg-icon i-document file-link-icon" aria-hidden="true"></span>${text}</button>`
      }
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
 * Attribute-agnostic: any well-formed anchor with a web href gets the icon,
 * whatever quoting or attributes the assistant used.
 */
const rawAnchorIconFixer = (input: string) => {
  return input.replace(
    /(<a\s+(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/a>/gi,
    (match, open: string, inner: string) => {
      if (inner.includes('external-link-icon')) return match
      if (!/href\s*=\s*(?:"https?:|'https?:|https?:)/i.test(open)) return match
      return `${open}${inner}${externalLinkIcon}</a>`
    },
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
