import { describe, expect, it } from 'vitest'
import { dropComfyUiParameters } from '../../../adapters/backends/comfyUiLaunchArgs'

describe('dropComfyUiParameters', () => {
  it('drops a bare flag and keeps the rest in order', () => {
    expect(dropComfyUiParameters(['--lowvram', '--reserve-vram', '6.0'], ['--lowvram'])).toEqual([
      '--reserve-vram',
      '6.0',
    ])
  })

  it('drops a flag together with its separate value', () => {
    expect(
      dropComfyUiParameters(['--lowvram', '--reserve-vram', '6.0', '--fp16-vae'], ['--reserve-vram']),
    ).toEqual(['--lowvram', '--fp16-vae'])
  })

  it('drops a flag written with an inline value', () => {
    expect(dropComfyUiParameters(['--reserve-vram=6.0', '--lowvram'], ['--reserve-vram'])).toEqual([
      '--lowvram',
    ])
  })

  it('does not swallow the next flag when the dropped one has no value', () => {
    expect(dropComfyUiParameters(['--lowvram', '--fp16-vae'], ['--lowvram'])).toEqual([
      '--fp16-vae',
    ])
  })

  it('leaves the argv alone when nothing is dropped', () => {
    const args = ['--lowvram', '--reserve-vram', '6.0']
    expect(dropComfyUiParameters(args, [])).toBe(args)
    expect(dropComfyUiParameters(args, ['--highvram'])).toEqual(args)
  })
})
