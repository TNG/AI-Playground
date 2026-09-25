import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNELS } from '@/types/ipcChannels'

// Registration exhaustiveness against the real manifest. Scanned patterns:
// typed `typedHandle(`/`typedOn(`/`typedSend(` call sites plus raw
// `ipcMain.handle(`/`ipcMain.on(`/`webContents.send(`/`ipcRenderer.*(`/`listen(`
// registrations, first argument a string literal or a same-file string `const`.
// A parameter-backed `sender.send(channel, …)` is invisible to that scan — it is
// the typedSend wrapper itself (electron/kernel/typedIpc.ts), and every channel
// through it shows up at its typedSend call site instead.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON_DIR = path.resolve(__dirname, '..', '..')

type RegistrationKind = 'handle' | 'on' | 'send'
type RawKind = RegistrationKind | 'preload-invoke' | 'preload-on' | 'preload-send' | 'listen'

type TypedSite = { file: string; channel: string; kind: RegistrationKind }
type RawSite = { file: string; channel: string; kind: RawKind }

// The kernel event stream is the one documented raw exception (ADR-0001): the
// bus pushes over plain `webContents.send` and preload subscribes through the
// raw `listen` helper. It has no manifest row by design — see
// `IpcExtraBridgeMembers.onKernelEvent` in src/types/ipcChannels.ts.
const RAW_ALLOWLIST: RawSite[] = [
  { file: path.join('kernel', 'kernelBus.ts'), channel: 'kernel:event', kind: 'send' },
  { file: 'preload.ts', channel: 'kernel:event', kind: 'listen' },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'test' && path.dirname(full) === ELECTRON_DIR) continue
      out.push(...walk(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function scan(): { typed: TypedSite[]; raw: RawSite[] } {
  const typed: TypedSite[] = []
  const raw: RawSite[] = []
  for (const file of walk(ELECTRON_DIR)) {
    const source = readFileSync(file, 'utf8')
    const rel = path.relative(ELECTRON_DIR, file)
    // Same-file `const NAME = 'channel'` declarations (kernelBus's event channel).
    const consts = new Map<string, string>()
    for (const m of source.matchAll(/const ([A-Za-z_$][\w$]*) = '([^']+)'/g)) consts.set(m[1], m[2])
    const channelOf = (token: string): string | null => {
      const literal = /^'([^']+)'$/.exec(token)
      if (literal) return literal[1]
      return consts.get(token) ?? null
    }
    for (const m of source.matchAll(/\btypedHandle\(\s*'([^']+)'/gs))
      typed.push({ file: rel, channel: m[1], kind: 'handle' })
    for (const m of source.matchAll(/\btypedOn\(\s*'([^']+)'/gs))
      typed.push({ file: rel, channel: m[1], kind: 'on' })
    for (const m of source.matchAll(/\btypedSend\(\s*[A-Za-z_$][\w$.]*\s*,\s*'([^']+)'/gs))
      typed.push({ file: rel, channel: m[1], kind: 'send' })
    for (const [pattern, kind] of [
      [/\bipcMain\.handle\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'handle'],
      [/\bipcMain\.on\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'on'],
      [/\bwebContents\.send\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'send'],
      [/\bipcRenderer\.invoke\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'preload-invoke'],
      [/\bipcRenderer\.on\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'preload-on'],
      [/\bipcRenderer\.send\(\s*('([^']+)'|[A-Za-z_$][\w$]*)/gs, 'preload-send'],
      [/\blisten\(\s*'([^']+)'/gs, 'listen'],
    ] as const) {
      for (const m of source.matchAll(pattern)) {
        const channel = channelOf(m[1])
        if (channel !== null) raw.push({ file: rel, channel, kind })
      }
    }
  }
  return { typed, raw }
}

const { typed: TYPED_SITES, raw: RAW_SITES } = scan()

const isHomeAgentServiceFile = (file: string) => /homeAgent/i.test(file)

describe('channel manifest registration scan', () => {
  const rows = Object.entries(CHANNELS).map(([name, row]) => ({
    name,
    kind: row.kind,
    owner: row.owner,
  }))

  it('registers every manifest row through its typed wrapper', () => {
    const missing = rows
      .map((row) => {
        const kind = row.kind === 'invoke' ? 'handle' : row.kind === 'send' ? 'on' : 'send'
        const sites = TYPED_SITES.filter((s) => s.channel === row.name && s.kind === kind)
        return { row, sites }
      })
      .filter(({ sites }) => sites.length === 0)
      .map(({ row }) => `${row.owner} ${row.kind} '${row.name}' has no typed registration`)
    expect(missing).toEqual([])
  })

  it('places every registration on its owner side', () => {
    const offenders: string[] = []
    for (const row of rows) {
      const kind = row.kind === 'invoke' ? 'handle' : row.kind === 'send' ? 'on' : 'send'
      const sites = TYPED_SITES.filter((s) => s.channel === row.name && s.kind === kind)
      for (const site of sites) {
        const inside = isHomeAgentServiceFile(site.file)
        if (row.owner === 'homeAgent' ? !inside : inside) {
          offenders.push(
            `'${row.name}' (owner ${row.owner}) is registered in ${site.file}, owner misplaced`,
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('registers no channel the manifest does not declare', () => {
    const known = new Set(rows.map((r) => r.name))
    const unknown = TYPED_SITES.filter((s) => !known.has(s.channel)).map(
      (s) => `${s.file} registers '${s.channel}', which has no manifest row`,
    )
    expect(unknown).toEqual([])
  })

  it('subscribes every push row through a preload listener', () => {
    const preload = readFileSync(path.join(ELECTRON_DIR, 'preload.ts'), 'utf8')
    const listened = new Set(
      [...preload.matchAll(/\bon(?:Push|Raw)\(\s*'([^']+)'/gs)].map((m) => m[1]),
    )
    const missing = rows
      .filter((r) => r.kind === 'push' && !listened.has(r.name))
      .map((r) => `push '${r.name}' has no onPush/onRaw listener in preload.ts`)
    expect(missing).toEqual([])
  })

  it('has no raw registrations outside the kernel-stream allowlist', () => {
    const strays = RAW_SITES.filter(
      (site) =>
        !RAW_ALLOWLIST.some(
          (allowed) =>
            allowed.file === site.file &&
            allowed.channel === site.channel &&
            allowed.kind === site.kind,
        ),
    ).map((site) => `${site.file}: raw ${site.kind} on '${site.channel}'`)
    expect(strays).toEqual([])
  })
})
