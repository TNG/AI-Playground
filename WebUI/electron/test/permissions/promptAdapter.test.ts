import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as unknown[])

vi.mock('../../kernel/kernelBus', () => ({
  getKernelEventWindow: () => ({ isDestroyed: () => false, webContents: {} }),
}))
vi.mock('../../kernel/typedIpc', () => ({
  typedSend: (_contents: unknown, _channel: string, payload: unknown) => sent.push(payload),
}))

const {
  handlePermissionsPromptResponse,
  permissionPromptsPending,
  requestPermissionsPrompt,
  resetPermissionsPromptAdapterForTest,
} = await import('../../permissions/promptAdapter')

beforeEach(() => {
  sent.length = 0
  resetPermissionsPromptAdapterForTest()
})

describe('permissions prompt channel (main)', () => {
  it('drops a prompt in the window as soon as its turn is aborted', async () => {
    const turn = new AbortController()
    const prompt = requestPermissionsPrompt(
      { kind: 'download', models: [], skipConfirmation: false },
      {
        signal: turn.signal,
      },
    )
    const { requestId } = sent[0] as { requestId: string }
    turn.abort()
    await expect(prompt).rejects.toThrow('The turn that asked has ended.')
    expect(sent[1]).toEqual({ kind: 'drop', requestId })
    expect(permissionPromptsPending()).toBe(0)
    // A late answer from the window for the dropped prompt is ignored.
    handlePermissionsPromptResponse({ requestId, result: true })
  })

  it('hears that the user answered before the prompt resolves', async () => {
    const onAnswered = vi.fn()
    const prompt = requestPermissionsPrompt<boolean>(
      { kind: 'download', models: [], skipConfirmation: false },
      { onAnswered },
    )
    const { requestId } = sent[0] as { requestId: string }
    handlePermissionsPromptResponse({ requestId, answered: true })
    expect(onAnswered).toHaveBeenCalledTimes(1)
    expect(permissionPromptsPending()).toBe(1)
    handlePermissionsPromptResponse({ requestId, result: true })
    await expect(prompt).resolves.toBe(true)
  })
})
