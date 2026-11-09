/**
 * Build a Windows offline folder next to the NSIS exe: OVMS, Gemma, the uv cache, VC++.
 * Run on Windows after `npm run build`. Refuses other platforms so the cache is not filled
 * with the wrong wheels.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { buildOvmsCandidates } from '../../electron/adapters/backends/ovmsDownloadUrls.ts'
import { portableGitArchive } from '../../electron/adapters/install/portableGitPin.ts'
import {
  OFFLINE_PYTHON_VERSION,
  OFFLINE_UV_MARKER,
  OFFLINE_UV_PROJECTS,
} from '../../electron/adapters/install/uvBasedBackends/offlineUv.ts'
import { ELECTRON_DIR, REPO_ROOT, RESOURCES_DIR, SEVEN_ZIP_EXE } from './build-paths.mts'

const STAGE_ROOT = path.join(REPO_ROOT, 'build', 'offline')
const BUNDLE_DIR = path.join(STAGE_ROOT, 'AI.Playground-offline')
const PAYLOAD_DIR = path.join(BUNDLE_DIR, 'payload')
const UV_WORKSPACE = path.join(STAGE_ROOT, 'uv-workspace')
const PYTHON_SEED = path.join(STAGE_ROOT, 'python-interpreter')

type HfTreeEntry = { path?: string; size?: number; type?: string }

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

if (process.platform !== 'win32') {
  fail(
    [
      'build:offline only runs on Windows.',
      'It downloads the Windows OVMS build, the Windows VC++ redistributable, and Windows Python wheels.',
      'On the Windows machine, from WebUI: npm run build && npm run build:offline',
    ].join('\n'),
  )
}

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })

const downloadFile = async (url: string, dest: string, expectedSize?: number) => {
  if (existsSync(dest)) {
    const size = statSync(dest).size
    if (expectedSize === undefined || size === expectedSize) {
      console.log(`keep ${dest}`)
      return
    }
  }
  console.log(`download ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) ${url}`)
  }
  await mkdir(path.dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  const size = statSync(partial).size
  if (expectedSize !== undefined && size !== expectedSize) {
    await rm(partial, { force: true })
    throw new Error(`${url} wrote ${size} bytes, expected ${expectedSize}`)
  }
  await rename(partial, dest)
}

const findInstaller = () => {
  if (!existsSync(ELECTRON_DIR)) {
    fail(`No installer directory at ${ELECTRON_DIR}. From WebUI, run npm run build first.`)
  }
  const exes = readdirSync(ELECTRON_DIR)
    .filter(
      (name) => name.toLowerCase().endsWith('.exe') && !name.toLowerCase().includes('uninstall'),
    )
    .map((name) => path.join(ELECTRON_DIR, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const exe = exes[0]
  if (!exe) fail(`No installer exe in ${ELECTRON_DIR}. From WebUI, run npm run build first.`)
  return exe
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown

const gemmaRepo = async () => {
  const preset = (await readJson(
    path.join(REPO_ROOT, 'modes', 'base', 'presets', 'home-agent-chat.json'),
  )) as { preferredModels?: { openVINO?: string } }
  const repo = preset.preferredModels?.openVINO
  if (!repo || !repo.startsWith('OpenVINO/')) {
    return fail('Home Agent preset has no OpenVINO preferred model to bundle.')
  }
  return repo
}

const ovmsVersion = async () => {
  const versions = (await readJson(
    path.join(REPO_ROOT, 'WebUI', 'external', 'backend-versions.json'),
  )) as { 'openvino-backend'?: { version?: string } }
  const version = versions['openvino-backend']?.version
  if (!version) return fail('backend-versions.json has no openvino-backend version.')
  return version
}

const flattenOvms = async (dir: string) => {
  if (existsSync(path.join(dir, 'ovms.exe'))) return
  const entries = readdirSync(dir)
  if (entries.length !== 1) return
  const only = path.join(dir, entries[0] ?? '')
  if (!statSync(only).isDirectory()) return
  for (const name of readdirSync(only)) {
    await rename(path.join(only, name), path.join(dir, name))
  }
  await rm(only, { recursive: true, force: true })
}

const stageOvms = async (version: string) => {
  const ovmsDir = path.join(PAYLOAD_DIR, 'OpenVINO', 'ovms')
  const exe = path.join(ovmsDir, 'ovms.exe')
  if (!existsSync(exe)) {
    const url = buildOvmsCandidates({ platform: 'win32', version, distros: [] })[0]
    if (!url) fail('No Windows OVMS download URL for this version.')
    const zip = path.join(STAGE_ROOT, 'ovms.zip')
    await downloadFile(url, zip)
    await mkdir(ovmsDir, { recursive: true })
    const extracted = spawnSync('tar', ['-xf', zip, '-C', ovmsDir], { stdio: 'inherit' })
    if (extracted.status !== 0) fail('Failed to extract the OVMS archive. Windows tar is required.')
    await flattenOvms(ovmsDir)
  }
  if (!existsSync(exe)) fail(`OVMS extract did not produce ${exe}`)
  await writeFile(
    path.join(PAYLOAD_DIR, 'OpenVINO', 'installed-version.json'),
    `${JSON.stringify({ version }, null, 2)}\n`,
  )
}

const stageGemma = async (repo: string) => {
  const folder = repo.replaceAll('/', '---')
  const destRoot = path.join(PAYLOAD_DIR, 'models', 'LLM', 'openvino', folder)
  const treeUrl = `https://huggingface.co/api/models/${repo}/tree/main`
  const response = await fetch(treeUrl)
  if (!response.ok) fail(`Hugging Face tree request failed (${response.status}) ${treeUrl}`)
  const entries = (await response.json()) as HfTreeEntry[]
  const files = entries.filter(
    (entry): entry is HfTreeEntry & { path: string; size: number } =>
      entry.type === 'file' && typeof entry.path === 'string' && typeof entry.size === 'number',
  )
  if (files.length === 0) fail(`Hugging Face returned no files for ${repo}`)
  for (const file of files) {
    const relative = file.path ?? ''
    const dest = path.join(destRoot, relative)
    const url = `https://huggingface.co/${repo}/resolve/main/${relative}?download=true`
    await downloadFile(url, dest, file.size)
  }
}

const stagePortableGit = async () => {
  const dest = path.join(PAYLOAD_DIR, portableGitArchive.fileName)
  if (existsSync(dest) && (await sha256File(dest)) === portableGitArchive.sha256) {
    console.log(`keep ${dest}`)
    return
  }
  await downloadFile(portableGitArchive.url, dest)
  const actual = await sha256File(dest)
  if (actual !== portableGitArchive.sha256) {
    await rm(dest, { force: true })
    fail(`Portable Git sha256 ${actual} does not match ${portableGitArchive.sha256}`)
  }
}

const stageUvCache = async () => {
  const cacheDir = path.join(PAYLOAD_DIR, 'uv-cache')
  const uv = path.join(RESOURCES_DIR, 'uv.exe')
  if (!existsSync(uv)) {
    fail(`uv.exe not found at ${uv}. From WebUI, run npm run fetch-external-resources.`)
  }
  await mkdir(UV_WORKSPACE, { recursive: true })
  for (const project of OFFLINE_UV_PROJECTS) {
    const source = path.join(REPO_ROOT, project)
    const lock = path.join(source, 'uv.lock')
    if (!existsSync(lock)) fail(`Missing ${lock}`)
    cpSync(source, path.join(UV_WORKSPACE, project), {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src)
        return name !== '.venv' && name !== '__pycache__' && name !== 'models' && name !== 'ovms'
      },
    })
  }
  const env = {
    ...process.env,
    UV_CACHE_DIR: cacheDir,
    UV_PYTHON_INSTALL_DIR: PYTHON_SEED,
    UV_NO_ENV_FILE: '1',
    UV_NO_CONFIG: '1',
    UV_PYTHON_PREFERENCE: 'only-managed',
  }
  const runUv = (args: string[]) => {
    console.log(`uv ${args.join(' ')}`)
    const result = spawnSync(uv, args, { env, stdio: 'inherit' })
    if (result.status !== 0) fail(`uv ${args.join(' ')} failed`)
  }
  runUv(['python', 'install', OFFLINE_PYTHON_VERSION])
  for (const project of OFFLINE_UV_PROJECTS) {
    runUv([
      'sync',
      '--directory',
      UV_WORKSPACE,
      '--project',
      project,
      '--python',
      OFFLINE_PYTHON_VERSION,
    ])
  }
  await writeFile(path.join(cacheDir, OFFLINE_UV_MARKER), 'offline installer cache\n')
}

const archiveBundle = () => {
  if (!existsSync(SEVEN_ZIP_EXE)) {
    console.warn(
      `7zr.exe not found at ${SEVEN_ZIP_EXE}. The folder is ready; no split archive was written.`,
    )
    return
  }
  const archive = path.join(STAGE_ROOT, 'AI.Playground-offline.7z')
  const result = spawnSync(
    SEVEN_ZIP_EXE,
    ['a', '-mx=0', '-v1900m', archive, path.basename(BUNDLE_DIR)],
    { cwd: STAGE_ROOT, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    console.warn('7zr did not write the split archive. Copy the folder itself.')
  }
}

const installer = findInstaller()
await mkdir(PAYLOAD_DIR, { recursive: true })
const version = await ovmsVersion()
const repo = await gemmaRepo()
console.log(`OVMS ${version}, model ${repo}`)
await stageOvms(version)
await stageGemma(repo)
await stagePortableGit()
await downloadFile(
  'https://aka.ms/vs/17/release/vc_redist.x64.exe',
  path.join(PAYLOAD_DIR, 'vc_redist.x64.exe'),
)
const cmdSource = path.join(REPO_ROOT, 'WebUI', 'build', 'offline', 'install-offline.cmd')
await writeFile(path.join(PAYLOAD_DIR, 'install-offline.cmd'), await readFile(cmdSource))
await stageUvCache()
const stagedExe = path.join(BUNDLE_DIR, path.basename(installer))
await pipeline(createReadStream(installer), createWriteStream(stagedExe))
archiveBundle()
console.log('')
console.log(`Offline installer folder: ${BUNDLE_DIR}`)
console.log('Copy that folder to the target machine and run the exe inside it.')
console.log('The payload folder has to stay next to the exe.')
