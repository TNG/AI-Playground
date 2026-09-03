import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

import {
  computeAttributes,
  computeMetricsProbeReport,
  computeWindowSince,
  latestComputeSnapshot,
  parseNvidiaSmiCsv,
  parseOptionalNumber,
  parseXpuSmiDiscoveryCsv,
  parseXpuSmiDiscoveryJson,
  parseXpuSmiDumpCsv,
  parseXpuSmiMemoryTotalMiB,
  pickPrimaryGpu,
  recordComputeSnapshotForTests,
  resetComputeMetricsForTests,
  setComputeMetricsSink,
  startComputeMetricsSampler,
  stopComputeMetricsSampler,
  summarizeWindow,
} from '../computeMetrics.ts'
import type { ComputeSnapshot } from '@/types/computeMetrics.ts'

describe('parseNvidiaSmiCsv', () => {
  it('reads a one-GPU query row', () => {
    const gpus = parseNvidiaSmiCsv(
      '0, NVIDIA GeForce RTX 4090, GPU-abc, 37, 8192, 24576, 120.50, 2100\n',
    )
    expect(gpus).toEqual([
      {
        id: '0',
        name: 'NVIDIA GeForce RTX 4090',
        vendor: 'nvidia',
        utilPct: 37,
        memUsedMiB: 8192,
        memTotalMiB: 24576,
        powerW: 120.5,
        freqMHz: 2100,
      },
    ])
  })

  it('skips N/A fields', () => {
    const [gpu] = parseNvidiaSmiCsv('0, NVIDIA, GPU-x, [N/A], 1024, 8192, N/A, [N/A]')
    expect(gpu?.utilPct).toBeUndefined()
    expect(gpu?.memUsedMiB).toBe(1024)
    expect(gpu?.powerW).toBeUndefined()
  })
})

describe('parseXpuSmiDumpCsv', () => {
  const dump = [
    'Timestamp, DeviceId, GPU Utilization (%), GPU Power (W), GPU Frequency (MHz), GPU Memory Utilization (%), GPU Memory Used (MiB)',
    '15:44:36.481, 0, 88.2, 42.1, 2400, 51.0, 8160.0',
    '15:44:36.481, 1, N/A, 12.0, 400, 2.03, 82.44',
  ].join('\n')

  it('matches columns by header name and keeps the last row per device', () => {
    const catalog = new Map([['0', { name: 'Intel Arc B580', memTotalMiB: 16384 }]])
    const gpus = parseXpuSmiDumpCsv(dump, catalog)
    expect(gpus).toHaveLength(2)
    expect(gpus[0]).toMatchObject({
      id: '0',
      name: 'Intel Arc B580',
      vendor: 'intel',
      utilPct: 88.2,
      memUsedMiB: 8160,
      memTotalMiB: 16384,
      freqMHz: 2400,
      powerW: 42.1,
    })
    expect(gpus[1]?.name).toBe('Intel GPU 1')
    expect(gpus[1]?.utilPct).toBeUndefined()
    expect(gpus[1]?.memTotalMiB).toBeCloseTo((82.44 / 2.03) * 100)
  })
})

describe('parseXpuSmiDiscoveryCsv', () => {
  it('reads quoted names and GiB sizes', () => {
    const csv = [
      'Device ID,Device Name,Memory Physical Size',
      '0,"Intel(R) Arc(TM) B580 Graphics","16 GiB"',
      '1,"Intel(R) Graphics",N/A',
    ].join('\n')
    const catalog = parseXpuSmiDiscoveryCsv(csv)
    expect(catalog.get('0')).toEqual({
      name: 'Intel(R) Arc(TM) B580 Graphics',
      memTotalMiB: 16384,
    })
    expect(catalog.get('1')?.memTotalMiB).toBeUndefined()
  })
})

describe('summarizeWindow', () => {
  const sample = (
    ts: number,
    util: number,
    mem: number,
    host: number,
    name = 'Intel Arc B580',
  ): ComputeSnapshot => ({
    ts,
    source: 'xpu-smi',
    host: { memUsedMiB: host, memTotalMiB: 32000 },
    gpus: [
      {
        id: '0',
        name,
        vendor: 'intel',
        utilPct: util,
        memUsedMiB: mem,
        memTotalMiB: 16384,
      },
    ],
  })

  it('takes peaks and last values for the hinted GPU', () => {
    const stats = summarizeWindow(
      [
        sample(1, 10, 1000, 8000, 'Intel Arc B580'),
        sample(2, 90, 8000, 12000, 'Intel Arc B580'),
        sample(3, 40, 4000, 9000, 'Intel Arc B580'),
      ],
      'B580',
    )
    expect(stats.sampleCount).toBe(3)
    expect(stats.gpuUtilPeakPct).toBe(90)
    expect(stats.gpuUtilLastPct).toBe(40)
    expect(stats.gpuMemPeakMiB).toBe(8000)
    expect(stats.gpuMemLastMiB).toBe(4000)
    expect(stats.hostMemPeakMiB).toBe(12000)
    expect(stats.hostMemLastMiB).toBe(9000)
    expect(stats.gpuName).toBe('Intel Arc B580')
  })
})

describe('pickPrimaryGpu', () => {
  it('prefers a name match over the hungriest card', () => {
    const picked = pickPrimaryGpu(
      [
        { id: '0', name: 'Intel Graphics', vendor: 'intel', memUsedMiB: 100 },
        { id: '1', name: 'Intel Arc B580', vendor: 'intel', memUsedMiB: 10 },
      ],
      'Arc B580',
    )
    expect(picked?.id).toBe('1')
  })
})

describe('computeAttributes', () => {
  it('omits GPU keys for a cloud turn', () => {
    const attrs = computeAttributes(
      {
        sampleCount: 1,
        gpuName: 'Intel Arc B580',
        gpuUtilPeakPct: 80,
        gpuMemPeakMiB: 8000,
        hostMemPeakMiB: 12000,
        hostMemLastMiB: 11000,
        hostMemTotalMiB: 32000,
      },
      false,
    )
    expect(attrs['aipg.gpu.util_peak_pct']).toBeUndefined()
    expect(attrs['aipg.host.mem_peak_mib']).toBe(12000)
  })
})

describe('sampler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetComputeMetricsForTests()
  })

  it('records host RAM even when GPU probes fail', async () => {
    const snapshots: ComputeSnapshot[] = []
    setComputeMetricsSink((s) => snapshots.push(s))
    startComputeMetricsSampler({
      intervalMs: 60_000,
      runCommand: async () => {
        throw new Error('missing')
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    stopComputeMetricsSampler()
    expect(snapshots[0]?.source).toBe('host')
    expect(snapshots[0]?.host.memTotalMiB).toBeGreaterThan(0)
    expect(snapshots[0]?.gpus).toEqual([])
  })

  it('windows samples from a start timestamp', () => {
    recordComputeSnapshotForTests({
      ts: 1000,
      source: 'host',
      host: { memUsedMiB: 1, memTotalMiB: 10 },
      gpus: [],
    })
    recordComputeSnapshotForTests({
      ts: 2000,
      source: 'host',
      host: { memUsedMiB: 5, memTotalMiB: 10 },
      gpus: [],
    })
    expect(computeWindowSince(1500).hostMemPeakMiB).toBe(5)
    expect(computeWindowSince(1500).sampleCount).toBe(1)
  })
})

// The Windows CLI is a different program from Linux `xpumcli` under the same
// name: no `discovery --dump`, and `dump` takes one device id (`-d -1` is
// rejected). Both spellings shipped Linux-only at first, so no Windows machine
// ever produced a GPU row.
describe('intel probe commands', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetComputeMetricsForTests()
  })

  const DISCOVERY_JSON = JSON.stringify({
    device_list: [
      { device_id: 0, device_name: 'Intel(R) Arc(TM) B580 Graphics', device_type: 'GPU' },
    ],
  })
  const DETAIL_JSON = JSON.stringify({ memory_physical_size_byte: 16 * 1024 * 1024 * 1024 })
  const DUMP_CSV = [
    'Timestamp, DeviceId, GPU Utilization (%), GPU Power (W), GPU Frequency (MHz), GPU Memory Utilization (%), GPU Memory Used (MiB)',
    '15:44:36.481, 0, 64.0, 40.0, 2400, 50.0, 8192.0',
  ].join('\n')

  function windowsRunner(calls: string[][]) {
    return async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args[0] === 'discovery' && args.includes('-d')) return DETAIL_JSON
      if (args[0] === 'discovery') return DISCOVERY_JSON
      if (args[0] === 'dump') {
        if (args.includes('-1')) throw new Error('Error: invalid device id')
        return DUMP_CSV
      }
      throw new Error(`unexpected: ${command} ${args.join(' ')}`)
    }
  }

  it('uses discovery -j and a per-device dump on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const calls: string[][] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      xpuSmiPath: 'C:\\app\\resources\\device-service\\xpu-smi.exe',
      runCommand: windowsRunner(calls),
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    const xpuCalls = calls.filter((c) => c[0].endsWith('xpu-smi.exe'))
    expect(xpuCalls.some((c) => c[1] === 'discovery' && c[2] === '-j')).toBe(true)
    expect(xpuCalls.some((c) => c.includes('--dump'))).toBe(false)
    const dump = xpuCalls.find((c) => c[1] === 'dump')
    expect(dump).toBeDefined()
    expect(dump).not.toContain('-1')
    expect(dump?.slice(1)).toEqual(['dump', '-d', '0', '-m', '0,1,2,5,18', '-n', '1'])

    const snapshot = latestComputeSnapshot()
    expect(snapshot?.source).toBe('xpu-smi')
    expect(snapshot?.gpus[0]).toMatchObject({
      name: 'Intel(R) Arc(TM) B580 Graphics',
      utilPct: 64,
      memUsedMiB: 8192,
      memTotalMiB: 16384,
    })
  })

  it('has no Intel probe on Windows without the bundled exe, and says so', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const calls: string[][] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      xpuSmiPath: null,
      runCommand: windowsRunner(calls),
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    expect(calls.some((c) => c[0].includes('xpu-smi'))).toBe(false)
    expect(computeMetricsProbeReport().intel.bin).toBeNull()
  })

  it('records why a probe failed', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    startComputeMetricsSampler({
      intervalMs: 60_000,
      xpuSmiPath: 'C:\\xpu-smi.exe',
      runCommand: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()
    expect(computeMetricsProbeReport().intel.lastError).toContain('ENOENT')
  })
})

describe('parseXpuSmiDiscoveryJson', () => {
  it('reads the Windows device list', () => {
    const catalog = parseXpuSmiDiscoveryJson(
      JSON.stringify({ device_list: [{ device_id: 1, device_name: 'Intel Arc A770' }] }),
    )
    expect(catalog.get('1')).toBe('Intel Arc A770')
  })

  it('survives non-JSON output', () => {
    expect(parseXpuSmiDiscoveryJson('not json').size).toBe(0)
  })
})

describe('parseXpuSmiMemoryTotalMiB', () => {
  it('converts a byte-spelled key', () => {
    expect(
      parseXpuSmiMemoryTotalMiB(JSON.stringify({ memory_physical_size_byte: 1073741824 })),
    ).toBe(1024)
  })

  it('takes a MiB-spelled key as-is', () => {
    expect(parseXpuSmiMemoryTotalMiB(JSON.stringify({ memory_physical_size: '14336.00' }))).toBe(
      14336,
    )
  })
})

describe('parseOptionalNumber', () => {
  it('treats blanks and N/A as missing', () => {
    expect(parseOptionalNumber('')).toBeUndefined()
    expect(parseOptionalNumber('N/A')).toBeUndefined()
    expect(parseOptionalNumber(' 12.5 ')).toBe(12.5)
  })
})
