/** Sessions whose agent turn main still holds, so a reload must not call their run closed. */
export async function liveAgentSessions(): Promise<Set<string>> {
  try {
    const snapshot = await window.electronAPI.getKernelSnapshot()
    return new Set(
      snapshot.state.agentTurns
        .filter(
          (turn) => turn.state === 'queued' || turn.state === 'running' || turn.state === 'paused',
        )
        .map((turn) => turn.sessionId),
    )
  } catch {
    return new Set()
  }
}
