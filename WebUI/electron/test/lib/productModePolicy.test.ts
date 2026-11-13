import { describe, expect, it } from 'vitest'
import { excludesOpenVino, pinnedTorchExtra, torchStackForMode } from '@/lib/productModePolicy'

describe('productModePolicy', () => {
  it('drops OpenVINO for NVIDIA and AMD installs', () => {
    expect(excludesOpenVino('nvidia')).toBe(true)
    expect(excludesOpenVino('amd')).toBe(true)
    expect(excludesOpenVino('studio')).toBe(false)
    expect(excludesOpenVino('essentials')).toBe(false)
    expect(excludesOpenVino(null)).toBe(false)
  })

  it('pins a torch extra only for a vendor mode', () => {
    expect(pinnedTorchExtra('nvidia')).toBe('cuda')
    expect(pinnedTorchExtra('amd')).toBe('rocm')
    expect(pinnedTorchExtra('studio')).toBeNull()
  })

  it('treats Intel modes as the same torch stack', () => {
    expect(torchStackForMode('studio')).toBe('default')
    expect(torchStackForMode('essentials')).toBe('default')
    expect(torchStackForMode('nvidia')).toBe('cuda')
    expect(torchStackForMode('amd')).toBe('rocm')
  })
})
