/** Replaces each `{key}` with its value; a placeholder with no value stays as written. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : token,
  )
}
