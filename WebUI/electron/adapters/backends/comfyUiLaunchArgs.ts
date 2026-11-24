/**
 * Removes each `dropped` flag from a ComfyUI argv, together with its value when
 * the next token is one (anything not itself a `--flag`).
 */
export function dropComfyUiParameters(args: string[], dropped: Iterable<string>): string[] {
  const drop = new Set(dropped)
  if (drop.size === 0) return args
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const [flag] = arg.split('=', 1)
    if (!drop.has(flag)) {
      out.push(arg)
      continue
    }
    const next = args[i + 1]
    if (flag === arg && next !== undefined && !next.startsWith('--')) i++
  }
  return out
}
