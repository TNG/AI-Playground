import { getToolOrDynamicToolName, isToolUIPart, type UIMessage } from 'ai'

// The tools whose calls create or change a file; the `path` they are called
// with is what an answer may mention and what a file chip opens.

const WRITING_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch'])

/** The files this message's writing tools created or changed, addressed the way the model addressed them. */
export function createdFilesOf(message: UIMessage): string[] {
  const paths = new Set<string>()
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue
    if (!WRITING_TOOLS.has(getToolOrDynamicToolName(part))) continue
    if (part.state !== 'output-available') continue
    const target = (part.input as { path?: unknown } | undefined)?.path
    if (typeof target === 'string' && target) paths.add(target)
  }
  return [...paths]
}

type FileMention = { form: string; rawPath: string }

// Only forms that end in a file-name-looking segment linkify, so a short path
// can never turn an ordinary word into a link.
function isFileName(form: string): boolean {
  const last = form.split('/').at(-1) ?? ''
  return last.includes('.') && last.length > 1
}

/**
 * The mention forms worth matching: every trailing run of a created file's path
 * segments, longest first, each kept only when exactly one file claims it —
 * two `index.html` writes make the bare name ambiguous, so only the longer,
 * unambiguous forms of each linkify.
 */
function mentionFormsOf(files: readonly string[]): FileMention[] {
  const claims = new Map<string, Set<string>>()
  for (const rawPath of files) {
    const posix = rawPath.replace(/\\/g, '/')
    const segments = posix.split('/').filter(Boolean)
    const forms = new Set([posix])
    for (let start = 0; start < segments.length; start++) {
      forms.add(segments.slice(start).join('/'))
    }
    for (const form of forms) {
      if (!isFileName(form)) continue
      const owners = claims.get(form) ?? new Set<string>()
      owners.add(rawPath)
      claims.set(form, owners)
    }
  }
  const mentions: FileMention[] = []
  for (const [form, owners] of claims) {
    if (owners.size === 1) mentions.push({ form, rawPath: [...owners][0] })
  }
  // Longest first: at a given position the regex tries the longest form, so a
  // directory-qualified mention is not cut short by its basename.
  return mentions.sort((a, b) => b.form.length - a.form.length)
}

const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
}

/**
 * Rewrites prose mentions of this turn's created files into `aipg-file:` links,
 * which the markdown parser renders as clickable file chips. Mentions inside
 * fenced blocks and inline code are left alone.
 */
export function linkifyAnswerFiles(
  text: string,
  files: readonly string[],
  tooltip?: string,
): string {
  if (!text || files.length === 0) return text
  const mentions = mentionFormsOf(files)
  if (mentions.length === 0) return text
  const byForm = new Map(mentions.map((mention) => [mention.form, mention]))
  // A mention may sit behind `@` (how prompts reference files) but never inside
  // a longer word, path, or link — and `game.js` must not match `game.jsx`.
  const pattern = new RegExp(
    mentions.map(({ form }) => `(?<![\\w.\\-/\\[(])${escapeRegExp(form)}(?![\\w-])`).join('|'),
    'g',
  )
  const title = tooltip ? ` "${tooltip.replace(/"/g, '')}"` : ''
  return text
    .split(CODE_SPANS)
    .map((piece, index) =>
      index % 2 === 1
        ? piece
        : piece.replace(pattern, (matched) => {
            const mention = byForm.get(matched)
            return mention
              ? `[${escapeLinkText(matched)}](aipg-file:${encodeURIComponent(mention.rawPath)}${title})`
              : matched
          }),
    )
    .join('')
}
