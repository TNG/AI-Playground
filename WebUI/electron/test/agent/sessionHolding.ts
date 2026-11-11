/** A new Session holding `harnessSessionId` as its Assistant Harness Session; returns its id. */
export async function sessionHolding(harnessSessionId: string): Promise<string> {
  const sessions = await import('../../session/sessions')
  const { id } = await sessions.createSession()
  await sessions.mutateSession(id, (file) => ({
    ...file,
    harnessSessions: { ...file.harnessSessions, Assistant: harnessSessionId },
  }))
  return id
}
