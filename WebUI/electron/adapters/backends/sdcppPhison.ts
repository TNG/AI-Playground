import path from 'node:path'
import * as filesystem from 'fs-extra'

/** GPU add-on packages of the shipment; CUDA and HIP get their own entry when they ship here. */
export type SdCppAddon = 'sycl'

export const SDCPP_DEFAULT_PART = 'NXWIH602T2'
/** Public bucket the shipment zips are downloaded from, one flat file per zip. */
export const SDCPP_PACKAGE_BASE_URL = 'https://phisonbucket.s3.ap-northeast-1.amazonaws.com'
export const SDCPP_SERVER_EXE = 'sd-server.exe'
export const SDCPP_ADA_SERVICE_NAME = 'ada_dit_service'
export const SDCPP_ADA_EXE = 'ada_dit.exe'
export const SDCPP_ADA_CREATE_SCRIPT = path.join('scripts', 'wDitService_create.bat')
export const SDCPP_ADA_DELETE_SCRIPT = path.join('scripts', 'wDitService_delete.bat')
/** Left in the install folder once ada_dit_service runs the packaged ada_dit.exe. */
export const SDCPP_ADA_READY_MARKER = 'ada-dit-service.ok'

const ADDON_MODULE: Record<SdCppAddon, string> = { sycl: 'ggml-sycl.dll' }

/** sha256 of each shipped zip, copied from the shipment's release page. */
const PACKAGE_SHA256: Record<string, Record<string, string>> = {
  NXWIH602T2: {
    'NXWIH602T2_x64.zip': 'ba46e2441f3d5ee1b3a8e567d5c87c27bfdf41cb60be1c11795d0462d5e495c4',
    'NXWIH602T2_x64_addon-sycl.zip':
      '6b5b9470b089d7c355809784cfc1482917d556e2b1619cdbf0c6e8c7e092fd3a',
  },
}

export type SdCppPackageFile = { url: string; fileName: string; sha256?: string }

export function sdcppPackageFiles(
  part: string,
  addon: SdCppAddon,
  baseUrl: string = SDCPP_PACKAGE_BASE_URL,
): SdCppPackageFile[] {
  const base = baseUrl.replace(/\/+$/, '')
  return [`${part}_x64.zip`, `${part}_x64_addon-${addon}.zip`].map((fileName) => {
    const sha256 = PACKAGE_SHA256[part]?.[fileName]
    return { url: `${base}/${fileName}`, fileName, ...(sha256 && { sha256 }) }
  })
}

export type SdCppImageModels = { diffusionModel: string; vae: string; llm: string }

const ROLE_BY_MODEL_TYPE: Record<string, keyof SdCppImageModels> = {
  unet: 'diffusionModel',
  diffusion_models: 'diffusionModel',
  clip: 'llm',
  text_encoders: 'llm',
  vae: 'vae',
}

/**
 * The preset's weights as the three files sd-server is started with. A required model
 * `owner/repo/rest` is downloaded to `<dir of its type>/owner---repo/rest`.
 */
export function resolveSdCppImageModels(
  required: { type: string; model: string }[],
  modelDir: (type: string) => string | undefined,
): SdCppImageModels | { missing: string[] } {
  const resolved: Partial<SdCppImageModels> = {}
  for (const { type, model } of required) {
    const role = ROLE_BY_MODEL_TYPE[type]
    const dir = modelDir(type)
    const parts = model.split('/')
    if (!role || !dir || parts.length < 3) continue
    resolved[role] = path.join(dir, `${parts[0]}---${parts[1]}`, ...parts.slice(2))
  }
  const missing = (['diffusionModel', 'llm', 'vae'] as const)
    .filter((role) => !resolved[role])
    .map((role) => (role === 'diffusionModel' ? 'diffusion model' : role))
  if (missing.length > 0) return { missing }
  return resolved as SdCppImageModels
}

const SD_SERVER_PORT_FIRST = 46000
const SD_SERVER_PORT_LAST = 46999

/** A fresh list each start: get-port's portNumbers() is a generator that empties after one use. */
export function sdServerPortCandidates(preferred: number): number[] {
  const range = Array.from(
    { length: SD_SERVER_PORT_LAST - SD_SERVER_PORT_FIRST + 1 },
    (_, i) => SD_SERVER_PORT_FIRST + i,
  )
  return range.includes(preferred) ? [preferred, ...range.filter((p) => p !== preferred)] : range
}

export function buildSdServerArgs(o: {
  outputDir: string
  port: number
  models: SdCppImageModels
  /** Weight store folder. Unset, sd-server uses its default location. */
  offloadPath?: string
  device?: string
}): string[] {
  return [
    '--preset',
    '--output-dir',
    o.outputDir,
    '--listen-ip',
    '127.0.0.1',
    '--listen-port',
    String(o.port),
    '--image-diffusion-model',
    o.models.diffusionModel,
    '--image-vae',
    o.models.vae,
    '--image-llm',
    o.models.llm,
    ...(o.offloadPath ? ['--offload-path', o.offloadPath] : []),
    ...(o.device ? ['--device', o.device] : []),
  ]
}

export type SdServerHealth =
  { state: 'ok' | 'loading' } | { state: 'error'; code: string; message: string }

export function parseSdServerHealth(status: number, body: string): SdServerHealth {
  let parsed: { status?: string; error?: { code?: string; message?: string } }
  try {
    parsed = JSON.parse(body)
  } catch {
    return { state: 'loading' }
  }
  if (status === 200 && parsed.status === 'ok') return { state: 'ok' }
  if (parsed.status === 'error') {
    return {
      state: 'error',
      code: parsed.error?.code ?? 'unknown',
      message: parsed.error?.message ?? 'sd-server reported a start-up problem',
    }
  }
  return { state: 'loading' }
}

/** `--list-devices` prints one `name<TAB>description` line per device. */
export function parseSdServerDevices(stdout: string): { id: string; name: string }[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 2 && cols[0].trim() !== '' && cols[0].trim() !== 'CPU')
    .map(([id, ...rest]) => ({ id: id.trim(), name: rest.join('\t').trim() }))
}

export function parseSdServerVersion(
  stdout: string,
): { version: string; releaseTag?: string } | undefined {
  // The last version part is a number (`6.0.2.1`) or starts with a letter (`6.0.2T2`).
  const match = stdout.match(/sd-server\s+(\d+(?:\.\d+){2}(?:\.\d+|[A-Za-z]\w*))(?:\s+(\S+))?/)
  if (!match) return undefined
  return match[2] ? { version: match[1], releaseTag: match[2] } : { version: match[1] }
}

export function computeSdCppArtifactsReady(
  serviceDir: string,
  addon: SdCppAddon = 'sycl',
): boolean {
  return [
    SDCPP_SERVER_EXE,
    ADDON_MODULE[addon],
    SDCPP_ADA_EXE,
    SDCPP_ADA_CREATE_SCRIPT,
    SDCPP_ADA_READY_MARKER,
  ].every((file) => filesystem.existsSync(path.join(serviceDir, file)))
}

export type AdaDitServiceInfo = { running: boolean; binary: string | null }

/** Reads the service query's two lines, State then PathName; null when there is no service. */
export function parseAdaDitServiceQuery(stdout: string): AdaDitServiceInfo | null {
  const [state = '', pathName = ''] = stdout.split(/\r?\n/).map((line) => line.trim())
  if (!state) return null
  return { running: state === 'Running', binary: serviceBinaryPath(pathName) }
}

function serviceBinaryPath(pathName: string): string | null {
  if (!pathName) return null
  const quoted = pathName.match(/^"([^"]+)"/)
  if (quoted) return quoted[1]
  // sc.exe stores the vendor script's binPath unquoted, spaces and all.
  return pathName.match(/^(.+?\.exe)(?=\s|$)/i)?.[1] ?? pathName
}

export function describeExitCode(code: number | null): string {
  if (code === null) return 'none (killed by a signal)'
  const unsigned = code >>> 0
  return unsigned > 0xffff ? `0x${unsigned.toString(16).toUpperCase()}` : String(code)
}

export function isInsideWindowsDir(child: string, dir: string): boolean {
  const relative = path.win32.relative(dir.toLowerCase(), child.toLowerCase())
  return relative !== '' && !relative.startsWith('..') && !path.win32.isAbsolute(relative)
}

/**
 * An unquoted binPath with spaces lets Windows run a planted `AI.exe` from a parent folder
 * as LocalSystem (CWE-428). The path sits outside cmd's quotes, so its metacharacters are escaped.
 */
export function quoteServiceBinaryCommand(serviceName: string, exePath: string): string {
  const escaped = exePath.replace(/[\^&|<>]/g, '^$&').replace(/%/g, '%%')
  return `sc.exe config ${serviceName} binPath= "\\"${escaped}\\""`
}

/** `sc create` fails with 1072 while a deleted service is still stopping. */
export function waitForServiceRemovalCommand(serviceName: string): string {
  return `for /l %%i in (1,1,30) do @(sc.exe query ${serviceName} >nul 2>&1 && ping -n 2 127.0.0.1 >nul)`
}
