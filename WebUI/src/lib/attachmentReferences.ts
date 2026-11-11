/**
 * The sentence that tells an agent which workspace files were attached to its prompt, as the
 * `@`-prefixed workspace-relative paths Pi refers to files by; empty when there are none.
 */
export function attachmentLine(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const references = paths.map((file) => (/\s/.test(file) ? `@"${file}"` : `@${file}`))
  return `Attached files, saved in the workspace: ${references.join(' ')}`
}
