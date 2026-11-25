// Turns a written file's text into markdown the transcript's MarkdownRenderer
// can show: markdown files render as themselves, everything else as one
// highlighted code block whose fence cannot occur inside the file.

import hljs from 'highlight.js'
import { sanitizeMarkdown } from '@/lib/sanitize'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  txt: 'plaintext',
}

export function languageOf(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').at(-1) ?? ''
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}

/** A fence the file cannot close itself: one longer than its longest backtick run. */
export function fenceFor(content: string): string {
  let longest = 0
  for (const run of content.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

export function isMarkdownFile(fileName: string): boolean {
  const extension = fileName.toLowerCase().split('.').at(-1) ?? ''
  return extension === 'md' || extension === 'markdown'
}

/** Markdown for the preview: the file itself when it is markdown, a code block otherwise. */
export function previewMarkdownOf(fileName: string, content: string): string {
  if (content === '') return ''
  if (isMarkdownFile(fileName)) return content
  const fence = fenceFor(content)
  const language = languageOf(fileName)
  return `${fence}${language}\n${content}\n${fence}`
}

/** The file's content as a bare highlighted code block — the Artifacts card's square tile. */
export function snippetHtmlOf(fileName: string, content: string): string {
  if (content === '') return ''
  const language = languageOf(fileName)
  const known = hljs.getLanguage(language) ? language : 'plaintext'
  const highlighted = hljs.highlight(content, { language: known }).value
  return sanitizeMarkdown(`<pre class="hljs"><code class="hljs">${highlighted}</code></pre>`)
}
