const renamedListeners = new Set<(from: string, to: string) => void>()

/** Called after an app-created Workspace folder was renamed on disk. */
export function onWorkspaceRenamed(listener: (from: string, to: string) => void): () => void {
  renamedListeners.add(listener)
  return () => renamedListeners.delete(listener)
}

export function emitWorkspaceRenamed(from: string, to: string): void {
  for (const listener of renamedListeners) listener(from, to)
}
