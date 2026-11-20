/**
 * A new Session holding `harnessSessionId` as its Assistant Harness Session, or as an Agent Run's
 * with `agentRun`; returns its id. Reachable unless asked otherwise, since only a Reachable
 * Session notifies.
 */
export async function sessionHolding(
  harnessSessionId: string,
  { reachable = true, agentRun = false }: { reachable?: boolean; agentRun?: boolean } = {},
): Promise<string> {
  const sessions = await import('../../session/sessions')
  const { id } = await sessions.createSession()
  await sessions.mutateSession(id, (file) => ({
    ...file,
    reachable,
    ...(agentRun
      ? { taskRunHarnessSessions: [...file.taskRunHarnessSessions, harnessSessionId] }
      : { harnessSessions: { ...file.harnessSessions, Assistant: harnessSessionId } }),
  }))
  return id
}
