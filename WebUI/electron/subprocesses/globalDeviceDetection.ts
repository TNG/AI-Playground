/**
 * Global AI device detection.
 *
 * Always uses OpenVINO (via the OpenVINO Python environment) to detect Intel devices.
 * When `recogniseNonIntelDevices` is true (dev mode), additionally detects:
 *   - Apple Silicon (via platform + sysctl)
 *   - NVIDIA GPUs (via nvidia-smi)
 *   - Other discrete / integrated GPUs (generic fallback via platform APIs)
 */

import { spawn } from 'node:child_process'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { app } from 'electron'
import * as filesystem from 'fs-extra'
import { appLoggerInstance } from '../logging/logger.ts'
import { aipgBaseDir } from './uvBasedBackends/uv.ts'

const execAsync = promisify(exec)

const LOG_SOURCE = 'globalDeviceDetection'

/**
 * In development mode (`!app.isPackaged`) we also run non-Intel detection.
 * Flip this constant to explicitly control the behaviour in dev.
 */
export const recogniseNonIntelDevices: boolean = !app.isPackaged


// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type DetectedDeviceKind = 'intel' | 'nvidia' | 'apple-silicon' | 'gpu'

export type DetectedDevice = {
  /** Stable identifier used to reference this device (e.g. OpenVINO id or "NVIDIA:0") */
  id: string
  /** Human-readable display name */
  name: string
  /** Broad category of the device */
  kind: DetectedDeviceKind
}

export type GlobalDetectionResult = {
  /** All successfully detected devices */
  devices: DetectedDevice[]
  /** ISO timestamp of the detection run */
  detectedAt: string
}

// ---------------------------------------------------------------------------
// OpenVINO-based Intel device detection
// ---------------------------------------------------------------------------

// Deduplicate: only one OpenVINO detection ever runs per process lifetime.
// Vite hot-reload causes multiple initServiceRegistry calls in the same
// Electron process; without this the second call would race against the first
// one still holding OpenVINO's shared library handles.
let openVinoDetectionPromise: Promise<DetectedDevice[]> | null = null
let openVinoChildProcess: ReturnType<typeof spawn> | null = null

/**
 * Called by main.ts on `before-quit` to kill the in-flight detection child
 * process immediately, so it doesn't linger until the 8 s timeout fires
 * while Electron is already tearing down.
 */
export function abortOpenVinoDetection(): void {
  if (openVinoChildProcess) {
    openVinoChildProcess.kill('SIGTERM')
    openVinoChildProcess = null
  }
}

/**
 * Runs the OpenVINO `detect_devices.py` script via `uv run` inside the OpenVINO
 * project to enumerate all devices visible to OpenVINO (CPU, GPU.*, NPU, etc.).
 *
 * Returns an empty array when OpenVINO is not yet installed or uv is unavailable.
 */
async function detectIntelDevicesViaOpenVINO(): Promise<DetectedDevice[]> {
  if (openVinoDetectionPromise) {
    appLoggerInstance.info(
      'OpenVINO detection already in-flight or completed — reusing result',
      LOG_SOURCE,
    )
    return openVinoDetectionPromise
  }

  const serviceDir = path.resolve(path.join(aipgBaseDir, 'OpenVINO'))
  const detectScript = path.resolve(path.join(serviceDir, 'detect_devices.py'))
  const venvDir = path.resolve(path.join(serviceDir, '.venv'))
  // Invoke the venv Python directly — avoids any uv environment locks, which
  // can cause the second Electron process (spawned by Vite hot-reload) to hang
  // waiting for the lock held by the first process's OpenVINO runtime.
  const pythonExe = path.join(
    venvDir,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )

  if (!filesystem.existsSync(detectScript)) {
    appLoggerInstance.info(
      `detect_devices.py not found at ${detectScript} — skipping Intel device detection`,
      LOG_SOURCE,
    )
    return []
  }

  if (!filesystem.existsSync(pythonExe)) {
    appLoggerInstance.info(
      `OpenVINO venv Python not found at ${pythonExe} — OpenVINO not yet installed, skipping Intel device detection`,
      LOG_SOURCE,
    )
    return []
  }

  openVinoDetectionPromise = new Promise<DetectedDevice[]>((resolve) => {
    const childProcess = spawn(pythonExe, [detectScript], {
      cwd: serviceDir,
      windowsHide: true,
      env: {
        ...process.env,
        VIRTUAL_ENV: venvDir,
        PATH: `${path.join(venvDir, 'Scripts')};${path.join(venvDir, 'bin')};${process.env.PATH}`,
      },
    })
    openVinoChildProcess = childProcess

    let stdout = ''
    let stderr = ''

    childProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    childProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    childProcess.on('error', (err: Error) => {
      openVinoChildProcess = null
      appLoggerInstance.error(
        `OpenVINO device detection process error: ${err}`,
        LOG_SOURCE,
      )
      resolve([])
    })

    childProcess.on('exit', (code: number | null) => {
      openVinoChildProcess = null
      if (code !== 0) {
        appLoggerInstance.warn(
          `OpenVINO detect_devices.py exited with code ${code}: ${stderr}`,
          LOG_SOURCE,
        )
        resolve([])
        return
      }

      try {
        const result = JSON.parse(stdout.trim()) as {
          success: boolean
          devices?: { id: string; name: string }[]
          error?: string
        }

        if (!result.success || !Array.isArray(result.devices)) {
          appLoggerInstance.warn(
            `OpenVINO detect_devices.py returned error: ${result.error}`,
            LOG_SOURCE,
          )
          resolve([])
          return
        }

        const devices: DetectedDevice[] = result.devices.map((d) => ({
          id: d.id,
          name: d.name,
          kind: 'intel' as DetectedDeviceKind,
        }))

        appLoggerInstance.info(
          `OpenVINO detected ${devices.length} Intel device(s): ${devices.map((d) => d.id).join(', ')}`,
          LOG_SOURCE,
        )
        resolve(devices)
      } catch (parseErr) {
        appLoggerInstance.error(
          `Failed to parse OpenVINO detect_devices.py output: ${stdout}`,
          LOG_SOURCE,
        )
        resolve([])
      }
    })

    // Timeout — OpenVINO init can be slow on first run, but if it exceeds this
    // the venv is likely locked by another Electron process (e.g. Vite hot-reload).
    setTimeout(() => {
      childProcess.kill('SIGTERM')
      appLoggerInstance.warn('OpenVINO device detection timed out after 8 s', LOG_SOURCE)
      resolve([])
    }, 8_000)
  })

  return openVinoDetectionPromise
}

// ---------------------------------------------------------------------------
// Apple Silicon detection
// ---------------------------------------------------------------------------

async function detectAppleSilicon(): Promise<DetectedDevice[]> {
  if (process.platform !== 'darwin') {
    return []
  }

  try {
    // `sysctl hw.optional.arm64` returns 1 on Apple Silicon Macs
    const { stdout } = await execAsync('sysctl -n hw.optional.arm64')
    if (stdout.trim() === '1') {
      // Get brand string for a nicer name
      let brandString = 'Apple Silicon'
      try {
        const { stdout: brand } = await execAsync('sysctl -n machdep.cpu.brand_string')
        brandString = brand.trim() || brandString
      } catch {
        // Ignore — brand string is cosmetic
      }

      appLoggerInstance.info(`Detected Apple Silicon: ${brandString}`, LOG_SOURCE)
      return [
        {
          id: 'APPLE_SILICON',
          name: brandString,
          kind: 'apple-silicon',
        },
      ]
    }
  } catch {
    // Not Apple Silicon or sysctl not available
  }

  return []
}

// ---------------------------------------------------------------------------
// NVIDIA GPU detection
// ---------------------------------------------------------------------------

async function detectNvidiaGPUs(): Promise<DetectedDevice[]> {
  try {
    // nvidia-smi is available on Windows, Linux, and macOS with CUDA drivers
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name --format=csv,noheader,nounits',
    )

    const devices: DetectedDevice[] = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const commaIndex = line.indexOf(',')
        const index = line.slice(0, commaIndex).trim()
        const name = line.slice(commaIndex + 1).trim()
        return {
          id: `NVIDIA:${index}`,
          name,
          kind: 'nvidia' as DetectedDeviceKind,
        }
      })

    if (devices.length > 0) {
      appLoggerInstance.info(
        `Detected ${devices.length} NVIDIA GPU(s): ${devices.map((d) => d.name).join(', ')}`,
        LOG_SOURCE,
      )
    }

    return devices
  } catch {
    // nvidia-smi not available or no NVIDIA drivers installed
    return []
  }
}

// ---------------------------------------------------------------------------
// Generic GPU detection (fallback for other discrete / integrated GPUs)
// ---------------------------------------------------------------------------

/**
 * Generic GPU detection via OS-provided tools.
 *
 * - Windows: `wmic path win32_VideoController get Name`
 * - Linux: `lspci` filtered for VGA / 3D / Display entries
 * - macOS: `system_profiler SPDisplaysDataType` for non-Apple-Silicon
 *
 * Returns devices that do NOT look like Intel or NVIDIA hardware
 * (those are already captured by the dedicated detectors above).
 */
async function detectOtherGPUs(alreadyKnownIds: Set<string>): Promise<DetectedDevice[]> {
  const rawGpus = await enumerateRawGPUs()

  return rawGpus
    .filter((gpu) => {
      // Skip Intel devices — already covered by OpenVINO detection
      if (/intel/i.test(gpu.name)) return false
      // Skip NVIDIA devices — already covered by nvidia-smi
      if (/nvidia/i.test(gpu.name)) return false
      // Skip Apple Metal / built-in display controllers on ARM macOS
      if (/apple m\d/i.test(gpu.name)) return false
      // Skip if already known
      if (alreadyKnownIds.has(gpu.id)) return false
      return true
    })
    .map((gpu) => ({
      id: gpu.id,
      name: gpu.name,
      kind: 'gpu' as DetectedDeviceKind,
    }))
}

type RawGPU = { id: string; name: string }

async function enumerateRawGPUs(): Promise<RawGPU[]> {
  if (process.platform === 'win32') {
    return enumerateRawGPUsWindows()
  }
  if (process.platform === 'linux') {
    return enumerateRawGPUsLinux()
  }
  if (process.platform === 'darwin') {
    return enumerateRawGPUsMacOS()
  }
  return []
}

async function enumerateRawGPUsWindows(): Promise<RawGPU[]> {
  try {
    const { stdout } = await execAsync(
      'wmic path win32_VideoController get DeviceID,Name /format:csv',
    )
    return stdout
      .trim()
      .split('\n')
      .slice(1) // skip CSV header
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parts = line.split(',')
        // CSV format: Node,DeviceID,Name
        const deviceId = (parts[1] ?? '').trim()
        const name = parts.slice(2).join(',').trim()
        return { id: deviceId || name, name }
      })
      .filter((g) => g.name.length > 0)
  } catch {
    return []
  }
}

async function enumerateRawGPUsLinux(): Promise<RawGPU[]> {
  try {
    const { stdout } = await execAsync(
      "lspci | grep -E '(VGA|3D|Display) compatible controller'",
    )
    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, idx) => {
        // lspci format: <slot> <class>: <name>
        const colonIdx = line.indexOf(':')
        const name = colonIdx >= 0 ? line.slice(colonIdx + 1).trim() : line.trim()
        const slot = line.slice(0, colonIdx >= 0 ? colonIdx : 8).trim()
        return { id: slot || `GPU:${idx}`, name }
      })
  } catch {
    return []
  }
}

async function enumerateRawGPUsMacOS(): Promise<RawGPU[]> {
  try {
    const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json')
    const data = JSON.parse(stdout) as {
      SPDisplaysDataType?: { sppci_model?: string; _name?: string }[]
    }
    const displays = data.SPDisplaysDataType ?? []
    return displays
      .map((d, idx) => ({
        id: `GPU:${idx}`,
        name: d.sppci_model ?? d._name ?? `GPU ${idx}`,
      }))
      .filter((g) => g.name.length > 0)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Runs global AI-capable device detection.
 *
 * Always uses OpenVINO to detect Intel devices first, then decides whether to
 * scan for non-Intel devices (Apple Silicon, NVIDIA, other GPUs) according to:
 *
 * | Intel found | `detectNonIntelDevices` | Non-Intel scan |
 * |-------------|------------------------|----------------|
 * | no          | any                    | ✅ always       |
 * | yes         | false (prod default)   | ❌ skipped      |
 * | yes         | true  (dev / opt-in)   | ✅ performed    |
 *
 * @param detectNonIntelDevices - driven by `settings.detectNonIntelDevicesIfAnyIntelDeviceFound`;
 *   falls back to the module-level `recogniseNonIntelDevices` constant when not provided.
 */
export async function detectAllAiDevices(
  detectNonIntelDevices: boolean = recogniseNonIntelDevices,
): Promise<GlobalDetectionResult> {
  appLoggerInstance.info(
    `Starting global device detection (detectNonIntelDevices=${detectNonIntelDevices})`,
    LOG_SOURCE,
  )

  const allDevices: DetectedDevice[] = []

  // Step 1: Intel devices via OpenVINO (always)
  try {
    const intelDevices = await detectIntelDevicesViaOpenVINO()
    allDevices.push(...intelDevices)
  } catch (err) {
    appLoggerInstance.error(`Intel device detection failed: ${err}`, LOG_SOURCE)
  }

  const intelDeviceFound = allDevices.some((d) => d.kind === 'intel')

  // Step 2: Non-Intel devices.
  // - No Intel found → always scan (machine may have no Intel GPU at all)
  // - Intel found + detectNonIntelDevices false → skip (prod default)
  // - Intel found + detectNonIntelDevices true → scan (dev / explicit opt-in)
  const shouldScanNonIntel = !intelDeviceFound || detectNonIntelDevices

  if (shouldScanNonIntel) {
    appLoggerInstance.info(
      intelDeviceFound
        ? 'Intel device found and non-Intel detection enabled — scanning for additional devices'
        : 'No Intel devices found — scanning for non-Intel devices regardless',
      LOG_SOURCE,
    )

    // Apple Silicon
    try {
      const appleSilicon = await detectAppleSilicon()
      allDevices.push(...appleSilicon)
    } catch (err) {
      appLoggerInstance.warn(`Apple Silicon detection failed: ${err}`, LOG_SOURCE)
    }

    // NVIDIA GPUs
    try {
      const nvidiaDevices = await detectNvidiaGPUs()
      allDevices.push(...nvidiaDevices)
    } catch (err) {
      appLoggerInstance.warn(`NVIDIA GPU detection failed: ${err}`, LOG_SOURCE)
    }

    // Other GPUs (generic)
    try {
      const knownIds = new Set(allDevices.map((d) => d.id))
      const otherGpus = await detectOtherGPUs(knownIds)
      allDevices.push(...otherGpus)
    } catch (err) {
      appLoggerInstance.warn(`Generic GPU detection failed: ${err}`, LOG_SOURCE)
    }
  } else {
    appLoggerInstance.info(
      'Intel device found and non-Intel detection disabled — skipping non-Intel scan',
      LOG_SOURCE,
    )
  }

  const result: GlobalDetectionResult = {
    devices: allDevices,
    detectedAt: new Date().toISOString(),
  }

  appLoggerInstance.info(
    `Global device detection complete: ${allDevices.length} device(s) found`,
    LOG_SOURCE,
  )

  return result
}

