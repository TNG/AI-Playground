import { describe, expect, it, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: class {},
  net: {},
}))
vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))
vi.mock('../../adapters/hardware/screenCapture.ts', () => ({ captureWindow: vi.fn() }))
vi.mock('../../agent/piCustomTools.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeToolInRenderer: vi.fn(),
  sendToolImage: vi.fn(),
}))

const { mediaCapability } = await import('../../agent/capabilities/media.ts')

async function skillsFor(toolNames: string[]) {
  const host = {
    toolSpecs: toolNames.map((name) => ({ name })),
    sessionMedia: { workspace: 'files' },
  }
  return await mediaCapability.buildSkills!(host as never)
}

describe('naming a generated result in a reply', () => {
  for (const [label, toolNames] of [
    ['the delegated media tool', ['media']],
    ['the direct image tools', ['generateImage', 'editImage']],
  ] as const) {
    it(`sends ${label} to the path, not a URL, for image, video and audio`, async () => {
      const skill = (await skillsFor([...toolNames])).find(
        (entry) => entry.name === 'media-generation',
      )!

      expect(skill.body).toContain(
        'name an image, video or audio result by its workspace-relative path',
      )
      expect(skill.body).toContain("neither the preview server's address")
      expect(skill.body).toContain('<img src=')
    })
  }

  it('does the same for a spoken clip', async () => {
    const speech = (await skillsFor(['synthesizeTextToSpeech'])).find(
      (entry) => entry.name === 'speech-audio',
    )!

    expect(speech.body).toContain('plays a synthesized clip back')
    expect(speech.body).toContain('never by a URL')
  })
})
