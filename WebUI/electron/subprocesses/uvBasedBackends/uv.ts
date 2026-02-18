import { app } from 'electron'
import { appLoggerInstance } from '../../logging/logger.ts'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import z from 'zod'

export const aipgBaseDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '../../../')
const buildResources = app.isPackaged ? aipgBaseDir : path.join(aipgBaseDir, 'build', 'resources')
const uvPath = path.join(buildResources, 'uv.exe')

const assertUv = async (logger: ReturnType<typeof loggerFor>) => {
  try {
    await fs.promises.access(uvPath, fs.constants.X_OK)
    logger.info(`Found UV executable at ${uvPath}`)
  } catch {
    logger.error(`UV executable not found at ${uvPath}`)
    throw new Error('UV executable not found')
  }
}

const loggerFor = (source: string) => ({
  info: (message: string) => {
    appLoggerInstance.info(message, source)
  },
  error: (message: string) => {
    appLoggerInstance.error(message, source)
  },
  warn: (message: string) => {
    appLoggerInstance.warn(message, source)
  },
})

const uv = (uvCommand: string[], logger: ReturnType<typeof loggerFor>, additionalEnv?: Record<string, string>) =>
  new Promise<void>((resolve, reject) => {
    logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
    const uvProcess = spawn(uvPath, uvCommand, {
      env: { ...process.env, UV_NO_ENV_FILE: '1', UV_NO_CONFIG: '1', VIRTUAL_ENV: undefined, ...additionalEnv },
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    uvProcess.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
      logger.info(`UV: ${text}`)
    })

    uvProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)
      logger.error(`UV Error: ${text}`)
    })

    uvProcess.on('close', (code: number) => {
      if (code === 0) {
        logger.info(`UV process completed successfully`)
        resolve()
      } else {
        const stdout = stdoutChunks.join('').trim()
        const stderr = stderrChunks.join('').trim()
        const errorMessage = stderr || stdout || `UV process exited with code ${code}`
        logger.error(`UV process exited with code ${code}`)
        reject(new Error(errorMessage))
      }
    })
  })

const uvWithJsonOutput = (uvCommand: string[], logger: ReturnType<typeof loggerFor>) =>
  new Promise<{ exitCode: number; jsonOutput: unknown; stdout: string; stderr: string }>(
    (resolve, reject) => {
      logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
      const uvProcess = spawn(uvPath, uvCommand, {
        env: { ...process.env, UV_NO_ENV_FILE: '1', UV_NO_CONFIG: '1', VIRTUAL_ENV: undefined },
      })

      let stdout = ''
      let stderr = ''
      let jsonOutput: unknown = null

      uvProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString()
        stdout += output
        logger.info(`UV: ${output}`)
      })

      uvProcess.stderr.on('data', (data: Buffer) => {
        const output = data.toString()
        stderr += output
        logger.error(`UV Error: ${output}`)
      })

      uvProcess.on('close', (code: number) => {
        // Try to parse JSON from complete stdout after process closes
        // This handles cases where JSON might be split across multiple chunks
        try {
          // Look for JSON in stdout - it might be on a single line or multiple lines
          const lines = stdout.trim().split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
              jsonOutput = JSON.parse(trimmed)
              break
            }
          }
          // If no single-line JSON found, try parsing the entire stdout as JSON
          if (!jsonOutput && stdout.trim().startsWith('{')) {
            jsonOutput = JSON.parse(stdout.trim())
          }
        } catch {
          // Not JSON or invalid JSON, jsonOutput remains null
          logger.warn('Could not parse JSON output from uv command')
        }

        resolve({ exitCode: code, jsonOutput, stdout, stderr })
      })

      uvProcess.on('error', (error) => {
        reject(error)
      })
    },
  )

/**
 * Detect if an error message indicates a UV cache hash mismatch
 */
const isHashMismatchError = (errorMessage: string): boolean => {
  return /hash mismatch/i.test(errorMessage)
}

export const installBackend = async (backend: string, onCacheCorruptionDetected?: () => void) => {
  const logger = loggerFor(`uv.sync.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--directory', aipgBaseDir, '--project', backend]
  logger.info(`Installing backend: ${backend} with ${JSON.stringify(uvCommand)}`)

  // Set UV_TORCH_BACKEND=cpu by default for ComfyUI to ensure CPU-compatible installation
  // This can be overridden by setting UV_TORCH_BACKEND=xpu in the environment for Intel Arc GPU systems
  const additionalEnv: Record<string, string> = {}
  if (backend === 'comfyui-deps' || backend.includes('ComfyUI')) {
    const torchBackend = process.env.UV_TORCH_BACKEND || 'cpu'
    additionalEnv.UV_TORCH_BACKEND = torchBackend
    logger.info(`Setting UV_TORCH_BACKEND=${torchBackend} for ComfyUI installation`)
  }

  try {
    return await uv(uvCommand, logger, additionalEnv)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (isHashMismatchError(errorMessage)) {
      logger.warn('Hash mismatch detected in UV cache, retrying with --no-cache')
      onCacheCorruptionDetected?.()
      const noCacheCommand = [...uvCommand, '--no-cache']
      return await uv(noCacheCommand, logger, additionalEnv)
    }

    throw error
  }
}

export const checkBackend = async (backend: string) => {
  const logger = loggerFor(`uv.check.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--check', '--directory', aipgBaseDir, '--project', backend]
  logger.info(`Checking backend: ${backend} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

export interface BackendCheckDetails {
  venvExists: boolean
  action: 'create' | 'check' | 'sync' | 'unknown'
  needsInstallation: boolean
  envMismatch: boolean
  exitCode: number
  jsonOutput?: unknown
  stdout?: string
  stderr?: string
}

/**
 * Check backend environment with detailed information about state
 * For ComfyUI, this checks if venv exists rather than exact lockfile match
 */
export const checkBackendWithDetails = async (
  backend: string,
  venvPath: string,
): Promise<BackendCheckDetails> => {
  const logger = loggerFor(`uv.check-details.${backend}`)
  await assertUv(logger)

  // Check if venv directory exists
  let venvExists = false
  try {
    await fs.promises.access(venvPath, fs.constants.F_OK)
    venvExists = true
    logger.info(`Venv directory exists at ${venvPath}`)
  } catch {
    logger.info(`Venv directory does not exist at ${venvPath}`)
    venvExists = false
  }

  // Run uv sync --check with JSON output
  const uvCommand = [
    'sync',
    '--check',
    '--output-format',
    'json',
    '--directory',
    aipgBaseDir,
    '--project',
    backend,
  ]
  logger.info(`Checking backend with details: ${backend} with ${JSON.stringify(uvCommand)}`)

  try {
    const result = await uvWithJsonOutput(uvCommand, logger)
    const parsedResult = z
      .object({
        sync: z.object({
          action: z.enum(['create', 'check', 'sync', 'unknown']),
        }),
      })
      .parse(result.jsonOutput)
    const action = parsedResult.sync.action

    // If exit code is 0, environment is in sync
    if (result.exitCode === 0) {
      return {
        venvExists,
        action,
        needsInstallation: false,
        envMismatch: false,
        exitCode: result.exitCode,
        jsonOutput: result.jsonOutput,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    }

    // Exit code != 0 means environment doesn't match
    // If action is 'create', venv doesn't exist yet
    // If action is 'check', venv exists but doesn't match
    const needsInstallation = !venvExists || action === 'create'
    const envMismatch = venvExists && action === 'check'

    return {
      venvExists,
      action,
      needsInstallation,
      envMismatch,
      exitCode: result.exitCode,
      jsonOutput: result.jsonOutput,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    // If command fails completely, assume environment needs installation if venv doesn't exist
    logger.error(`Failed to check backend details: ${error}`)
    return {
      venvExists,
      action: 'unknown',
      needsInstallation: !venvExists,
      envMismatch: venvExists, // If venv exists but check failed, it's a mismatch
      exitCode: -1,
    }
  }
}

export const installWheel = async (backend: string, wheelPath: string) => {
  const logger = loggerFor(`uv.wheel.${backend}`)
  await assertUv(logger)
  const uvCommand = ['pip', 'install', '--directory', path.join(aipgBaseDir, backend), wheelPath]
  logger.info(`Installing wheel: ${wheelPath} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

/**
 * Check if a Python package is installed in a backend's environment
 */
export const isPackageInstalled = async (
  backend: string,
  packageName: string,
): Promise<boolean> => {
  const logger = loggerFor(`uv.check-package.${backend}`)
  await assertUv(logger)

  // Extract package name from package specifier (handle .whl files and version specs)
  let pkgName = packageName
  if (packageName.endsWith('.whl')) {
    pkgName = packageName.split('/').pop()?.split('-')[0] || packageName
  } else {
    pkgName = packageName.split('==')[0].split('>=')[0].split('<=')[0].trim()
  }

  try {
    // Use uv pip show to check if package is installed
    // This returns exit code 0 if package exists, non-zero if not
    const uvCommand = ['pip', 'show', '--directory', path.join(aipgBaseDir, backend), pkgName]
    logger.info(`Checking if package ${pkgName} is installed`)

    await uv(uvCommand, logger)
    return true
  } catch (_error) {
    // Package not found - this is expected behavior, not an error
    logger.info(`Package ${pkgName} is not installed`)
    return false
  }
}

/**
 * Install a Python package using uv pip
 */
export const installPypiPackage = async (
  backend: string,
  packageSpecifier: string,
): Promise<void> => {
  const logger = loggerFor(`uv.install-package.${backend}`)
  await assertUv(logger)

  let pipSpecifier = packageSpecifier

  // Handle .whl files - download if it's a URL
  if (packageSpecifier.endsWith('.whl') && packageSpecifier.startsWith('http')) {
    const fileName = packageSpecifier.split('/').pop() || 'package.whl'
    const downloadPath = path.join(aipgBaseDir, backend, fileName)

    logger.info(`Downloading .whl file from ${packageSpecifier}`)
    const response = await fetch(packageSpecifier)

    if (!response.ok) {
      throw new Error(`Failed to fetch ${packageSpecifier}: ${response.statusText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    await fs.promises.writeFile(downloadPath, buffer)
    pipSpecifier = downloadPath
  }
  const uvCommand = ['add', '--directory', path.join(aipgBaseDir, backend), pipSpecifier]
  logger.info(`Installing package ${packageSpecifier}`)

  await uv(uvCommand, logger)

  // Clean up downloaded .whl file if it was a local download
  if (packageSpecifier.endsWith('.whl') && packageSpecifier.startsWith('http')) {
    try {
      await fs.promises.unlink(pipSpecifier)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Install requirements from requirements.txt using uv pip
 */
export const installRequirementsTxt = async (
  backend: string,
  requirementsTxtPath: string,
): Promise<void> => {
  const logger = loggerFor(`uv.install-requirements.${backend}`)
  await assertUv(logger)

  // Check if requirements.txt exists
  try {
    await fs.promises.access(requirementsTxtPath, fs.constants.R_OK)
  } catch {
    logger.warn(`Requirements file not found: ${requirementsTxtPath}`)
    return
  }

  const uvCommand = [
    'add',
    '--directory',
    path.join(aipgBaseDir, backend),
    '-r',
    requirementsTxtPath,
  ]
  logger.info(`Installing requirements from ${requirementsTxtPath}`)

  await uv(uvCommand, logger)
}

/**
 * Install ComfyUI backend with dual venv support (CPU + XPU)
 * Always installs CPU version, optionally installs XPU version if Intel Arc GPU detected
 */
export const installComfyUIBackend = async (
  serviceDir: string,
  detectIntelArcGpu: () => Promise<boolean>,
  onCacheCorruptionDetected?: () => void,
): Promise<{ cpuInstalled: boolean; xpuInstalled: boolean }> => {
  const logger = loggerFor('uv.comfyui-dual-venv')
  await assertUv(logger)

  const backendName = 'comfyui-deps'
  const venvCpuPath = path.join(serviceDir, '.venv-cpu')
  const venvXpuPath = path.join(serviceDir, '.venv-xpu')

  // Check if Intel Arc GPU is available
  const hasIntelArc = await detectIntelArcGpu()
  logger.info(`Intel Arc GPU detection: ${hasIntelArc ? 'Available' : 'Not available'}`)

  const results = { cpuInstalled: false, xpuInstalled: false }

  // Install CPU version (always) - Use PyTorch CPU from pytorch.org/whl/cpu
  logger.info('=== Installing ComfyUI with CPU backend (PyTorch CPU) ===')

  // First, create the venv and install base dependencies
  const cpuEnv = {
    UV_PROJECT_ENVIRONMENT: venvCpuPath,
  }

  try {
    // Step 1: Do a full sync to create venv and install all dependencies (including torch from xpu index initially)
    logger.info('CPU backend step 1: Creating venv and installing dependencies')
    const syncCommand = ['sync', '--directory', aipgBaseDir, '--project', backendName]
    await uv(syncCommand, logger, cpuEnv)

    // Step 2: Force-reinstall torch packages from CPU index to replace the XPU versions
    logger.info('CPU backend step 2: Replacing PyTorch XPU with PyTorch CPU from https://download.pytorch.org/whl/cpu')
    const pythonPath = path.join(venvCpuPath, 'Scripts', 'python.exe')
    const pipInstallCmd = [
      'pip', 'install',
      '--python', pythonPath,
      'torch>=2.10.0',
      'torchvision',
      'torchaudio',
      '--index-url', 'https://download.pytorch.org/whl/cpu',
      '--force-reinstall',
      '--no-deps',
    ]
    await uv(pipInstallCmd, logger, {})

    results.cpuInstalled = true
    logger.info('[OK] CPU backend installed successfully with PyTorch CPU')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (isHashMismatchError(errorMessage)) {
      logger.warn('Hash mismatch detected in UV cache, retrying with --no-cache')
      onCacheCorruptionDetected?.()

      const noCacheCommand = ['sync', '--directory', aipgBaseDir, '--project', backendName, '--no-cache']
      await uv(noCacheCommand, logger, cpuEnv)

      const pythonPath = path.join(venvCpuPath, 'Scripts', 'python.exe')
      const pipInstallCmd = [
        'pip', 'install',
        '--python', pythonPath,
        'torch>=2.10.0',
        'torchvision',
        'torchaudio',
        '--index-url', 'https://download.pytorch.org/whl/cpu',
        '--force-reinstall',
        '--no-deps',
      ]
      await uv(pipInstallCmd, logger, {})

      results.cpuInstalled = true
      logger.info('[OK] CPU backend installed successfully (retry)')
    } else {
      logger.error(`Failed to install CPU backend: ${errorMessage}`)
      throw error
    }
  }

  // Install XPU version (only if Intel Arc detected)
  if (hasIntelArc) {
    logger.info('=== Installing ComfyUI with XPU backend (Intel Arc GPU detected) ===')
    const xpuEnv = {
      UV_TORCH_BACKEND: 'xpu',
      UV_PROJECT_ENVIRONMENT: venvXpuPath,
    }

    try {
      const uvCommand = ['sync', '--directory', aipgBaseDir, '--project', backendName]
      logger.info(`Installing XPU backend: ${JSON.stringify(uvCommand)}`)
      await uv(uvCommand, logger, xpuEnv)
      results.xpuInstalled = true
      logger.info('[OK] XPU backend installed successfully')
    } catch (error) {
      // XPU installation is optional - don't fail if it doesn't work
      logger.warn(`Failed to install XPU backend (non-fatal): ${error}`)
      logger.warn('Continuing with CPU-only installation')
    }
  } else {
    logger.info('Skipping XPU backend installation (no Intel Arc GPU detected)')
  }

  logger.info(`ComfyUI installation complete: CPU=${results.cpuInstalled}, XPU=${results.xpuInstalled}`)
  return results
}

