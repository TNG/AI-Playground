import { describe, expect, it } from 'vitest'
import {
  applyGpuMemoryRollup,
  luidKey,
  namesOverlap,
  overlaySmiOntoWddm,
  parsePdhGpuInstance,
  peakEngineUtil,
} from '@/lib/wddmGpuMetrics'
import type { GpuSample } from '@/types/computeMetrics'

describe('parsePdhGpuInstance', () => {
  it('reads adapter memory instance names Task Manager uses', () => {
    expect(parsePdhGpuInstance('luid_0x00000000_0x00017AB2_phys_0')).toEqual({
      high: 0,
      low: 0x17ab2,
      phys: 0,
    })
  })

  it('reads GPU engine instances', () => {
    expect(parsePdhGpuInstance('luid_0x00000000_0x00017AB2_phys_0_eng_0_engtype_3D')).toMatchObject(
      {
        low: 0x17ab2,
        engine: 0,
        engineType: '3D',
      },
    )
  })
})

describe('applyGpuMemoryRollup', () => {
  it('sums dedicated+shared on an iGPU (B390-class carve-out)', () => {
    const gpu = applyGpuMemoryRollup({
      id: '0',
      name: 'Intel(R) Arc(TM) B390 GPU',
      vendor: 'intel',
      dedicatedUsedMiB: 80,
      dedicatedTotalMiB: 128,
      sharedUsedMiB: 4200,
      sharedTotalMiB: 16 * 1024,
    })
    expect(gpu.memUsedMiB).toBe(4280)
    expect(gpu.memTotalMiB).toBe(128 + 16 * 1024)
  })

  it('uses dedicated only on a discrete card', () => {
    const gpu = applyGpuMemoryRollup({
      id: '0',
      name: 'Intel(R) Arc(TM) B580 Graphics',
      vendor: 'intel',
      dedicatedUsedMiB: 8000,
      dedicatedTotalMiB: 12288,
      sharedUsedMiB: 200,
      sharedTotalMiB: 16000,
    })
    expect(gpu.memUsedMiB).toBe(8000)
    expect(gpu.memTotalMiB).toBe(12288)
  })
})

describe('overlaySmiOntoWddm', () => {
  it('keeps WDDM memory and takes xpu-smi clocks', () => {
    const wddm: GpuSample[] = [
      applyGpuMemoryRollup({
        id: '0',
        name: 'Intel(R) Arc(TM) B390 GPU',
        vendor: 'intel',
        dedicatedUsedMiB: 90,
        dedicatedTotalMiB: 128,
        sharedUsedMiB: 3000,
        sharedTotalMiB: 16384,
        utilPct: 41,
      }),
    ]
    const smi: GpuSample[] = [
      {
        id: '0',
        name: 'Intel(R) Arc(TM) B390 GPU',
        vendor: 'intel',
        memUsedMiB: 9001,
        memTotalMiB: 128,
        utilPct: 99,
        freqMHz: 2400,
        powerW: 12,
      },
    ]
    const [gpu] = overlaySmiOntoWddm(wddm, smi)
    expect(gpu?.memUsedMiB).toBe(3090)
    expect(gpu?.memTotalMiB).toBe(16512)
    expect(gpu?.freqMHz).toBe(2400)
    expect(gpu?.powerW).toBe(12)
    expect(gpu?.utilPct).toBe(41)
  })

  it('falls back to SMI when WDDM is empty', () => {
    const smi: GpuSample[] = [
      { id: '0', name: 'NVIDIA', vendor: 'nvidia', memUsedMiB: 1, memTotalMiB: 8 },
    ]
    expect(overlaySmiOntoWddm([], smi)).toEqual(smi)
  })
})

describe('peakEngineUtil', () => {
  it('takes the busiest engine per LUID, like Task Manager', () => {
    const key = luidKey(0, 0x17ab2, 0)
    expect(peakEngineUtil(new Map([[key, [3, 88, 12]]])).get(key)).toBe(88)
  })
})

describe('namesOverlap', () => {
  it('matches DXGI vs xpu-smi spellings of the same board', () => {
    expect(namesOverlap('Intel(R) Arc(TM) B390 GPU', 'Intel(R) Arc(TM) B390 GPU')).toBe(true)
  })
})
