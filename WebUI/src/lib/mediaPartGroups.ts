/**
 * Runs of consecutive media tool parts render as one shared grid, so several
 * tool calls in one prompt put their images side by side instead of one
 * stacked block per call. Any other part breaks a run.
 */
export function consecutiveMediaGroups(
  parts: readonly unknown[],
  isMedia: (part: unknown) => boolean,
  shownIndexes?: readonly number[],
): Map<number, number[]> {
  const indexes = shownIndexes
    ? [...new Set(shownIndexes)].sort((a, b) => a - b)
    : parts.map((_, index) => index)
  const groups = new Map<number, number[]>()
  let start: number | null = null
  let members: number[] = []
  const close = () => {
    if (start !== null) groups.set(start, members)
    start = null
    members = []
  }
  for (const index of indexes) {
    if (index >= 0 && index < parts.length && isMedia(parts[index])) {
      if (start === null) start = index
      members.push(index)
    } else {
      close()
    }
  }
  close()
  return groups
}
