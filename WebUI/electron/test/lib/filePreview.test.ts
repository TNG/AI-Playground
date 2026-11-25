import { describe, expect, it, vi } from 'vitest'

// Node has no DOM for DOMPurify; hljs escaping is what the assertions cover.
vi.mock('@/lib/sanitize', () => ({ sanitizeMarkdown: (html: string) => html }))

import {
  fenceFor,
  isMarkdownFile,
  languageOf,
  previewMarkdownOf,
  snippetHtmlOf,
} from '@/lib/filePreview'

describe('languageOf', () => {
  it('maps common extensions to highlight.js languages', () => {
    expect(languageOf('game.js')).toBe('javascript')
    expect(languageOf('index.html')).toBe('html')
    expect(languageOf('notes.MD')).toBe('plaintext')
    expect(languageOf('script.py')).toBe('python')
  })

  it('falls back to plaintext', () => {
    expect(languageOf('game.jsx')).toBe('javascript')
    expect(languageOf('unknown.xyz')).toBe('plaintext')
    expect(languageOf('noextension')).toBe('plaintext')
  })
})

describe('fenceFor', () => {
  it('uses a triple fence for plain text', () => {
    expect(fenceFor('no backticks here')).toBe('```')
  })

  it('outgrows the longest backtick run in the file', () => {
    expect(fenceFor('a ` b\n`` c ```\n')).toBe('````')
    expect(fenceFor('````\n')).toBe('`````')
  })
})

describe('isMarkdownFile', () => {
  it('recognizes markdown extensions case-insensitively', () => {
    expect(isMarkdownFile('design.md')).toBe(true)
    expect(isMarkdownFile('plan.markdown')).toBe(true)
    expect(isMarkdownFile('readme.MD')).toBe(true)
    expect(isMarkdownFile('game.js')).toBe(false)
  })
})

describe('previewMarkdownOf', () => {
  it('renders a markdown file as itself', () => {
    expect(previewMarkdownOf('design.md', '# Plan\n\nShip it.')).toBe('# Plan\n\nShip it.')
  })

  it('wraps other files in a language-tagged code fence', () => {
    expect(previewMarkdownOf('game.js', 'let x = 1')).toBe('```javascript\nlet x = 1\n```')
  })

  it('picks a fence the content cannot close', () => {
    const content = '```\ninner\n```\n'
    expect(previewMarkdownOf('notes.txt', content)).toBe('````plaintext\n```\ninner\n```\n\n````')
  })

  it('returns nothing for an empty file', () => {
    expect(previewMarkdownOf('game.js', '')).toBe('')
  })
})

describe('snippetHtmlOf', () => {
  it('wraps the source in a bare highlighted code block', () => {
    const html = snippetHtmlOf('game.js', 'const x = 1')
    expect(html).toContain('<pre class="hljs">')
    expect(html).toContain('hljs-keyword')
  })

  it('renders a markdown file as highlighted source, not rendered markdown', () => {
    expect(snippetHtmlOf('design.md', '# Plan')).not.toContain('<h1>')
  })

  it('escapes html-shaped content so nothing survives sanitization live', () => {
    const html = snippetHtmlOf('notes.txt', '<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('falls back to plaintext for unknown extensions', () => {
    expect(snippetHtmlOf('data.xyz', 'raw')).toContain('raw')
  })

  it('returns nothing for an empty file', () => {
    expect(snippetHtmlOf('game.js', '')).toBe('')
  })
})
