import { describe, expect, it } from 'vitest'
import {
  pickRecommendedProductMode,
  type RecommendableProductMode,
} from '../../kernel/productModeRecommendation'

const studio: RecommendableProductMode = {
  mode: 'studio',
  priority: 3,
  displayOrder: 20,
  recommendForIntelDeviceIds: ['0x56A0'],
  recommendForNvidia: false,
  recommendForAmd: false,
}

const essentials: RecommendableProductMode = {
  mode: 'essentials',
  priority: 20,
  displayOrder: 10,
  recommendForIntelDeviceIds: ['0xFD80', '0xFD81'],
  recommendForNvidia: false,
  recommendForAmd: false,
}

const nvidia: RecommendableProductMode = {
  mode: 'nvidia',
  priority: 10,
  displayOrder: 30,
  recommendForIntelDeviceIds: [],
  recommendForNvidia: true,
  recommendForAmd: false,
}

const amd: RecommendableProductMode = {
  mode: 'amd',
  priority: 10,
  displayOrder: 40,
  recommendForIntelDeviceIds: [],
  recommendForNvidia: false,
  recommendForAmd: true,
}

const catalog = [studio, essentials, nvidia, amd]

describe('pickRecommendedProductMode', () => {
  it('recommends essentials for a matching Intel device even when an NVIDIA GPU is present', () => {
    expect(pickRecommendedProductMode(catalog, ['0xFD80'], true, false)).toBe('essentials')
  })

  it('recommends nvidia when that GPU is present and no Intel mode matches', () => {
    expect(pickRecommendedProductMode(catalog, [], true, false)).toBe('nvidia')
  })

  it('recommends amd when that GPU is present and no Intel mode matches', () => {
    expect(pickRecommendedProductMode(catalog, [], false, true)).toBe('amd')
  })

  it('keeps nvidia ahead of amd when both GPUs are present', () => {
    expect(pickRecommendedProductMode(catalog, [], true, true)).toBe('nvidia')
  })

  it('ignores a vendor mode whose GPU was not probed', () => {
    expect(pickRecommendedProductMode(catalog, ['0x56A0'], false, false)).toBe('studio')
  })

  it('falls back to studio when nothing is eligible', () => {
    expect(pickRecommendedProductMode(catalog, [], false, false)).toBe('studio')
  })
})
