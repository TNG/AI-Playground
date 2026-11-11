/**
 * A new Session holding `harnessSessionId` as its Assistant Harness Session; returns its id.
 * Reachable unless asked otherwise, since only a Reachable Session notifies.
 */
export async function sessionHolding(
  harnessSessionId: string,
  { reachable = true }: { reachable?: boolean } = {},
): Promise<string> {
  const sessions = await import('../../session/sessions')
  const { id } = await sessions.createSession()
  await sessions.mutateSession(id, (file) => ({
    ...file,
    reachable,
    harnessSessions: { ...file.harnessSessions, Assistant: harnessSessionId },
  }))
  return id
}
