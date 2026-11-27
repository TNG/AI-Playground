/**
 * The sentence that tells an agent which files were attached to its prompt, as the `@`-prefixed
 * paths Pi refers to files by; empty when there are none.
 */
export function attachmentLine(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const references = paths.map((file) => (/\s/.test(file) ? `@"${file}"` : `@${file}`))
  return `Attached files: ${references.join(' ')}`
}
