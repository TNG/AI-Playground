import { getToolOrDynamicToolName, isToolUIPart, type UIMessage } from 'ai'

// The tools whose calls create or change a file; the `path` they are called
// with is what the turn's file chips open.

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

/** The files a turn created, across all its answers. */
export function createdFilesOfMessages(answers: readonly UIMessage[]): string[] {
  const paths = new Set<string>()
  for (const message of answers) {
    for (const path of createdFilesOf(message)) paths.add(path)
  }
  return [...paths]
}
