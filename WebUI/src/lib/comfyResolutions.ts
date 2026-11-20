/**
 * Resolution vocabulary for ComfyUI presets — the fixed lookup table, the
 * default aspect ratios and the megapixel/aspect-ratio → WxH mapping.
 *
 * Pure data + math only: main's in-process media tools need the same mapping
 * the renderer's tools use (electron/agent/capabilities/mediaDirect.ts),
 * so this lives in lib/ rather than the store module it came from.
 */
import type { MegapixelOption, ResolutionConfig } from '@/lib/presetSchemas'

// All values are divisible by 32 (most by 64)
// Portrait ratios are derived by swapping width/height of their landscape counterparts
// Uses `/` notation consistently (e.g., '16/9' not '16:9')
export const RESOLUTION_TABLE: Record<string, Record<string, [number, number]>> = {
  '0.25': {
    '1/1': [512, 512],
    '4/3': [576, 448],
    '3/4': [448, 576],
    '3/2': [640, 432],
    '2/3': [432, 640],
    '16/9': [672, 384],
    '9/16': [384, 672],
    '21/9': [768, 320],
    '9/21': [320, 768],
  },
  '0.5': {
    '1/1': [704, 704],
    '4/3': [832, 640],
    '3/4': [640, 832],
    '3/2': [896, 576],
    '2/3': [576, 896],
    '16/9': [960, 544],
    '9/16': [544, 960],
    '21/9': [1088, 448],
    '9/21': [448, 1088],
  },
  '0.8': {
    '1/1': [896, 896],
    '4/3': [1024, 768],
    '3/4': [768, 1024],
    '3/2': [1088, 704],
    '2/3': [704, 1088],
    '16/9': [1216, 672],
    '9/16': [672, 1216],
    '21/9': [1344, 576],
    '9/21': [576, 1344],
  },
  '1.0': {
    '1/1': [1024, 1024],
    '4/3': [1152, 896],
    '3/4': [896, 1152],
    '3/2': [1216, 832],
    '2/3': [832, 1216],
    '16/9': [1376, 768],
    '9/16': [768, 1376],
    '21/9': [1536, 640],
    '9/21': [640, 1536],
  },
  '1.2': {
    '1/1': [1120, 1120],
    '4/3': [1280, 960],
    '3/4': [960, 1280],
    '3/2': [1376, 928],
    '2/3': [928, 1376],
    '16/9': [1504, 832],
    '9/16': [832, 1504],
    '21/9': [1664, 704],
    '9/21': [704, 1664],
  },
  '1.5': {
    '1/1': [1248, 1248],
    '4/3': [1440, 1088],
    '3/4': [1088, 1440],
    '3/2': [1536, 1024],
    '2/3': [1024, 1536],
    '16/9': [1664, 928],
    '9/16': [928, 1664],
    '21/9': [1856, 768],
    '9/21': [768, 1856],
  },
  '4.0': {
    '1/1': [2048, 2048],
    '4/3': [2368, 1760],
    '3/4': [1760, 2368],
    '3/2': [2496, 1664],
    '2/3': [1664, 2496],
    '16/9': [2720, 1536],
    '9/16': [1536, 2720],
    '21/9': [3136, 1344],
    '9/21': [1344, 3136],
  },
  '8.0': {
    '1/1': [2912, 2912],
    '4/3': [3360, 2496],
    '3/4': [2496, 3360],
    '3/2': [3552, 2368],
    '2/3': [2368, 3552],
    '16/9': [3872, 2176],
    '9/16': [2176, 3872],
    '21/9': [4416, 1888],
    '9/21': [1888, 4416],
  },
  '12.0': {
    '1/1': [3552, 3552],
    '4/3': [4096, 3072],
    '3/4': [3072, 4096],
    '3/2': [4352, 2912],
    '2/3': [2912, 4352],
    '16/9': [4736, 2656],
    '9/16': [2656, 4736],
    '21/9': [5408, 2336],
    '9/21': [2336, 5408],
  },
  '16.0': {
    '1/1': [4096, 4096],
    '4/3': [4736, 3552],
    '3/4': [3552, 4736],
    '3/2': [5024, 3360],
    '2/3': [3360, 5024],
    '16/9': [5472, 3072],
    '9/16': [3072, 5472],
    '21/9': [6272, 2688],
    '9/21': [2688, 6272],
  },
}

// Mapping for legacy notation (colon) to standard notation (slash)
const ASPECT_RATIO_MAP: Record<string, string> = {
  '1:1': '1/1',
  '4:3': '4/3',
  '3:4': '3/4',
  '3:2': '3/2',
  '2:3': '2/3',
  '16:9': '16/9',
  '9:16': '9/16',
  '21:9': '21/9',
  '9:21': '9/21',
  '12/5': '21/9', // 12:5 = 2.4, close to 21:9 = 2.333
  '5/12': '9/21',
}

export type MegapixelTier =
  '0.25' | '0.5' | '0.8' | '1.0' | '1.2' | '1.5' | '4.0' | '8.0' | '12.0' | '16.0'

/**
 * Get resolution from the fixed lookup table
 * @param megapixels - The megapixel tier (e.g., '0.25', '0.5', '0.8', '1.0', '1.2', '1.5')
 * @param aspectRatio - The aspect ratio in fractional or colon notation (e.g., '16/9', '16:9', '9/16')
 * @returns Resolution object with width, height, and totalPixels
 */
export function getResolutionFromTable(
  megapixels: string,
  aspectRatio: string,
): { width: number; height: number; totalPixels: number } | null {
  const mpTable = RESOLUTION_TABLE[megapixels]
  if (!mpTable) return null

  // Convert fractional notation to colon notation if needed
  const normalizedRatio = ASPECT_RATIO_MAP[aspectRatio] || aspectRatio

  const resolution = mpTable[normalizedRatio]
  if (!resolution) return null

  const [width, height] = resolution
  return { width, height, totalPixels: width * height }
}

/**
 * Get all resolutions for a given megapixel tier
 * @param megapixels - The megapixel tier
 * @returns Array of resolution objects with aspectRatio, width, height, and totalPixels
 */
export function getResolutionsForMegapixel(megapixels: string): Array<{
  aspectRatio: string
  width: number
  height: number
  totalPixels: number
}> {
  const mpTable = RESOLUTION_TABLE[megapixels]
  if (!mpTable) return []

  return Object.entries(mpTable).map(([ratio, [width, height]]) => ({
    aspectRatio: ratio,
    width,
    height,
    totalPixels: width * height,
  }))
}

/**
 * Dynamic resolution calculation - used as fallback for special cases like LTX Video
 * Kept for backward compatibility
 */
export function findBestResolution(totalPixels: number, aspectRatio: number) {
  const MIN_SIZE = 256
  const MAX_SIZE = 1920
  let bestWidth = 0
  let bestHeight = 0
  let minDiff = Infinity

  for (let h = MIN_SIZE; h <= MAX_SIZE; h += 64) {
    let w = aspectRatio * h
    w = Math.round(w / 64) * 64

    if (w < MIN_SIZE || w > MAX_SIZE) continue

    const actualPixels = w * h
    const diff = Math.abs(actualPixels - totalPixels)

    if (diff < minDiff) {
      minDiff = diff
      bestWidth = w
      bestHeight = h
    }
  }

  return { width: bestWidth, height: bestHeight, totalPixels: bestWidth * bestHeight }
}

// ============================================================================
// Resolution Configuration Utilities
// ============================================================================

/**
 * Default aspect ratios available for image generation (landscape to portrait order)
 */
export const DEFAULT_ASPECT_RATIOS = [
  '21/9',
  '16/9',
  '3/2',
  '4/3',
  '1/1',
  '3/4',
  '2/3',
  '9/16',
  '9/21',
]

/**
 * Default SDXL resolution configuration (fallback when preset has no config)
 */
export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  megapixels: [
    { label: '0.25', totalPixels: 512 * 512 },
    { label: '0.5', totalPixels: 704 * 704 },
    { label: '0.8', totalPixels: 896 * 896 },
    { label: '1.0', totalPixels: 1024 * 1024 },
  ],
  aspectRatios: DEFAULT_ASPECT_RATIOS,
  useLookupTable: true,
}

/**
 * Parse an aspect ratio string (e.g., "16/9") to a numeric value
 * @param aspectRatio - The aspect ratio string in fractional notation
 * @returns The numeric aspect ratio value (width / height)
 */
export function parseAspectRatio(aspectRatio: string): number {
  const parts = aspectRatio.split('/')
  if (parts.length !== 2) return 1
  const [w, h] = parts.map(Number)
  if (!w || !h || h === 0) return 1
  return w / h
}

/**
 * Compute resolution from megapixel config and aspect ratio
 * Uses lookup table or dynamic calculation based on config
 */
export function computeResolution(
  megapixels: MegapixelOption,
  aspectRatio: string,
  useLookupTable: boolean,
): { width: number; height: number; totalPixels: number } {
  // Try lookup table first if enabled
  if (useLookupTable && RESOLUTION_TABLE[megapixels.label]) {
    const tableRes = getResolutionFromTable(megapixels.label, aspectRatio)
    if (tableRes) {
      return tableRes
    }
  }

  // Fall back to dynamic calculation
  const aspectValue = parseAspectRatio(aspectRatio)
  return findBestResolution(megapixels.totalPixels, aspectValue)
}

/**
 * Get all available resolutions from a resolution configuration
 * @param config - The resolution configuration from a preset
 * @returns Array of all resolution combinations
 */
export function getResolutionsFromConfig(config: ResolutionConfig): Array<{
  aspectRatio: string
  megapixels: string
  width: number
  height: number
  totalPixels: number
}> {
  const resolutions: Array<{
    aspectRatio: string
    megapixels: string
    width: number
    height: number
    totalPixels: number
  }> = []

  const useLookup = config.useLookupTable !== false

  for (const mp of config.megapixels) {
    for (const ar of config.aspectRatios) {
      const { width, height, totalPixels } = computeResolution(mp, ar, useLookup)
      resolutions.push({
        aspectRatio: ar,
        megapixels: mp.label,
        width,
        height,
        totalPixels,
      })
    }
  }

  return resolutions
}

/**
 * Get a specific resolution for a megapixel tier and aspect ratio
 * @param config - The resolution configuration
 * @param megapixelLabel - The megapixel label (e.g., "1.0")
 * @param aspectRatio - The aspect ratio (e.g., "16/9")
 * @returns Resolution object or null if not found
 */
export function getResolutionForConfig(
  config: ResolutionConfig,
  megapixelLabel: string,
  aspectRatio: string,
): { width: number; height: number; totalPixels: number } | null {
  const mp = config.megapixels.find((m) => m.label === megapixelLabel)
  if (!mp) return null

  if (!config.aspectRatios.includes(aspectRatio)) return null

  const useLookup = config.useLookupTable !== false
  return computeResolution(mp, aspectRatio, useLookup)
}

/**
 * Find the best matching resolution from a config given target dimensions
 * @param config - The resolution configuration
 * @param targetWidth - Target width
 * @param targetHeight - Target height
 * @returns The closest matching resolution
 */
export function findClosestResolutionInConfig(
  config: ResolutionConfig,
  targetWidth: number,
  targetHeight: number,
): {
  megapixelLabel: string
  aspectRatio: string
  width: number
  height: number
} | null {
  const allResolutions = getResolutionsFromConfig(config)
  if (allResolutions.length === 0) return null

  let bestMatch = allResolutions[0]
  let minDiff =
    Math.abs(allResolutions[0].width - targetWidth) +
    Math.abs(allResolutions[0].height - targetHeight)

  for (const res of allResolutions) {
    const diff = Math.abs(res.width - targetWidth) + Math.abs(res.height - targetHeight)
    if (diff < minDiff) {
      minDiff = diff
      bestMatch = res
    }
  }

  return {
    megapixelLabel: bestMatch.megapixels,
    aspectRatio: bestMatch.aspectRatio,
    width: bestMatch.width,
    height: bestMatch.height,
  }
}
