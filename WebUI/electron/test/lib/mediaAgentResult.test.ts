import { describe, expect, it } from 'vitest'
import { condenseMediaAgentRun, slimCondensedMedia } from '@/lib/mediaAgentResult'

describe('condenseMediaAgentRun', () => {
  it('flattens inner tool images and keeps the specialist summary', () => {
    const result = condenseMediaAgentRun({
      text: 'Made a castle.',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            images: [{ id: '1', type: 'image', imageUrl: 'aipg-media://a.png', mode: 'imageGen' }],
          },
        },
      ],
    })
    expect(result.summary).toBe('Made a castle.')
    expect(result.images).toHaveLength(1)
    expect(result.steps[0]).toContain('Draft Image')
    expect(slimCondensedMedia(result).images).toEqual([
      { id: '1', type: 'image', imageUrl: 'aipg-media://a.png' },
    ])
  })

  // A Game Agent run that got the raw sprite and its cut-out side by side kept
  // regenerating towers it already had, unsure which file was the finished one.
  it('marks the image an edit step consumed as intermediate', () => {
    const image = (id: string) => ({
      images: [{ id, type: 'image', imageUrl: `aipg-media://${id}.png`, mode: 'imageGen' }],
    })
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        { toolName: 'comfyUI', input: { workflow: 'Pro 2 Image' }, output: image('raw') },
        {
          toolName: 'comfyUiImageEdit',
          input: { workflow: 'Remove Background' },
          output: image('cutout'),
        },
        { toolName: 'comfyUI', input: { workflow: 'Pro 2 Image' }, output: image('concept') },
        {
          toolName: 'comfyUiImageEdit',
          input: { workflow: 'Pixel3D-Trellis' },
          output: {
            images: [
              { id: 'model', type: 'model3d', model3dUrl: 'aipg-media://m.glb', mode: 'imageEdit' },
            ],
          },
        },
      ],
    })
    expect(slimCondensedMedia(result).images).toEqual([
      { id: 'raw', type: 'image', imageUrl: 'aipg-media://raw.png', intermediate: true },
      { id: 'cutout', type: 'image', imageUrl: 'aipg-media://cutout.png' },
      { id: 'concept', type: 'image', imageUrl: 'aipg-media://concept.png', intermediate: true },
      { id: 'model', type: 'model3d', model3dUrl: 'aipg-media://m.glb' },
    ])
  })

  it('reports the last inner failure when nothing was produced', () => {
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'W1' },
          output: { success: false, message: 'backend died', images: [] },
        },
      ],
    })
    expect(result).toMatchObject({
      success: false,
      message: 'backend died',
      images: [],
    })
  })

  it('unwraps a nested tool-result envelope', () => {
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            type: 'tool-result',
            output: {
              images: [
                { id: '1', type: 'image', imageUrl: 'aipg-media://a.png', mode: 'imageGen' },
              ],
            },
          },
        },
      ],
    })
    expect(result.images).toHaveLength(1)
    expect(result.success).toBeUndefined()
  })

  it('unwraps a json tool-output envelope', () => {
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            type: 'json',
            value: {
              images: [
                { id: '1', type: 'image', imageUrl: 'aipg-media://a.png', mode: 'imageGen' },
              ],
            },
          },
        },
      ],
    })
    expect(result.images).toHaveLength(1)
  })
})
