/**
 * Global AI device detection.
 *
 * Uses OpenVINO (via the OpenVINO Python environment) to detect all AI devices.
 * OpenVINO is capable of detecting Intel, NVIDIA and AMD hardware.
 * When `detectNonIntelDevices` is false and Intel devices are found, non-Intel
 * devices are filtered out of the result.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'
import * as filesystem from 'fs-extra'
import { appLoggerInstance } from '../logging/logger.ts'
import { aipgBaseDir } from './uvBasedBackends/uv.ts'


const LOG_SOURCE = 'globalDeviceDetection'

/**
 * In development mode (`!app.isPackaged`) we also show non-Intel devices.
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

        // Filter out the AUTO pseudo-device — it is not a real hardware device
        const rawDevices = result.devices.filter((d) => d.id !== 'AUTO')

        const devices: DetectedDevice[] = rawDevices.map((d) => {
          let kind: DetectedDeviceKind

          if (d.id === 'APPLE_SILICON') {
            kind = 'apple-silicon'
          } else if (/nvidia/i.test(d.name)) {
            kind = 'nvidia'
          } else if (d.id === 'CPU' || /intel/i.test(d.name) || /npu/i.test(d.id)) {
            kind = 'intel'
          } else {
            // GPU.N synthesised entries (AMD iGPU, other discrete GPUs)
            kind = 'gpu'
          }

          return { id: d.id, name: d.name, kind }
        })

        appLoggerInstance.info(
          `OpenVINO detected ${devices.length} device(s): ${devices.map((d) => `${d.id} (${d.name})`).join(', ')}`,
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
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Runs global AI-capable device detection using OpenVINO.
 *
 * OpenVINO detects all AI-capable devices including Intel, NVIDIA, and AMD hardware.
 * Non-Intel devices are filtered out when Intel devices are present and
 * `detectNonIntelDevices` is false.
 *
 * | Intel found | `detectNonIntelDevices` | Non-Intel included |
 * |-------------|------------------------|--------------------|
 * | no          | any                    | ✅ always           |
 * | yes         | false (prod default)   | ❌ filtered out     |
 * | yes         | true  (dev / opt-in)   | ✅ included         |
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

  let allDevices: DetectedDevice[] = []

  try {
    allDevices = await detectIntelDevicesViaOpenVINO()
  } catch (err) {
    appLoggerInstance.error(`Device detection via OpenVINO failed: ${err}`, LOG_SOURCE)
  }

  const intelDeviceFound = allDevices.some((d) => d.kind === 'intel')

  // When Intel devices are present and non-Intel detection is disabled, filter
  // out any non-Intel devices that OpenVINO may have reported (e.g. NVIDIA, AMD).
  if (intelDeviceFound && !detectNonIntelDevices) {
    const before = allDevices.length
    allDevices = allDevices.filter((d) => d.kind === 'intel')
    if (allDevices.length !== before) {
      appLoggerInstance.info(
        `Filtered out ${before - allDevices.length} non-Intel device(s) (detectNonIntelDevices=false)`,
        LOG_SOURCE,
      )
    }
  }

  // Deduplicate by id
  const seen = new Set<string>()
  const deduplicated = allDevices.filter((d) => {
    if (seen.has(d.id)) return false
    seen.add(d.id)
    return true
  })

  const result: GlobalDetectionResult = {
    devices: deduplicated,
    detectedAt: new Date().toISOString(),
  }

  appLoggerInstance.info(
    `Global device detection complete — ${deduplicated.length} device(s): ${deduplicated.map((d) => `${d.id} (${d.name})`).join(', ') || 'none'}`,
    LOG_SOURCE,
  )

  return result
}

