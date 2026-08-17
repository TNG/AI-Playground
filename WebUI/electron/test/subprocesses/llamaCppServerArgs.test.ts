import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  net: {},
}))

const { buildLlmServerArgs, sanitizeUserLlamaCppParameters } =
  await import('../../subprocesses/llamaCppBackendService.ts')

// The flags a model asks for come from `models.json`, which the app also
// refreshes from a remote repo — so they are sanitized exactly like the user's,
// and they are placed where a hand-written flag can still override them.
describe('buildLlmServerArgs', () => {
  const base = {
    modelPath: '/models/qwen.gguf',
    port: 39100,
    contextSize: 32768,
    modelParameters: [] as string[],
    userParameters: [] as string[],
  }

  it('puts the model’s own flags before the user’s so the user wins', () => {
    const args = buildLlmServerArgs({
      ...base,
      modelParameters: ['--spec-default', '--spec-type', 'draft-mtp'],
      userParameters: ['--gpu-layers', '999', '--spec-type', 'none'],
    })
    expect(args.indexOf('draft-mtp')).toBeLessThan(args.lastIndexOf('--spec-type'))
    expect(args.at(-3)).toBe('none')
  })

  it('keeps the server on loopback whatever the flags say', () => {
    const args = buildLlmServerArgs({
      ...base,
      modelParameters: sanitizeUserLlamaCppParameters('--host 0.0.0.0 --spec-default'),
    })
    expect(args.filter((arg) => arg === '--host')).toHaveLength(1)
    expect(args.at(-1)).toBe('127.0.0.1')
    expect(args).toContain('--spec-default')
  })

  it('is the plain command line when no model asks for anything', () => {
    expect(buildLlmServerArgs({ ...base, userParameters: ['--jinja'] })).toEqual([
      '--model',
      '/models/qwen.gguf',
      '--port',
      '39100',
      '--ctx-size',
      '32768',
      '--jinja',
      '--host',
      '127.0.0.1',
    ])
  })
})
