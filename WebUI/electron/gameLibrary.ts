import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getGamesDir } from './util.ts'
import { writeScaffold } from './gameScaffold.ts'

// ── The game library ─────────────────────────────────────────────────────────
//
// One folder per game, holding everything that game needs:
//
//   games/
//     space-dodger/
//       game.json          ← this module's business
//       index.html         ← the page the game runs in (scaffolded, then edited)
//       game.js            ← the game itself (scaffolded, then edited)
//       icon.png           ← what the library and the hub page show
//       generated/         ← art the media tool produced
//     library.json         ← manifest for the (Q4) social portal upload
//     index.html           ← generated gallery, openable without the app
//
// There is deliberately no central index: `listGames()` scans for `game.json`
// files, so a folder the user copied in shows up and one they deleted is simply
// gone — an index would drift from the disk it describes.
//
// The folder name is the game's id and never changes. It doubles as the agent's
// workspace root (and thus the sandbox root, the preview server root and the key
// the Pi session is stored under), so renaming it later would strand a live
// session; the display name lives in `game.json` instead.

const GameMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  /** Game-folder-relative HTML file to open. */
  entry: z.string().default('index.html'),
  /** Game-folder-relative image, when the agent made one. */
  icon: z.string().optional(),
  /** False while the game is a draft the user has not saved to the library yet. */
  published: z.boolean().default(false),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
})

export type GameMetadata = z.infer<typeof GameMetadataSchema>

/** A game as the UI sees it: its metadata plus where it lives. */
export type GameEntry = GameMetadata & {
  /** Absolute path of the game folder. */
  dir: string
  /** Absolute path of the entry file, whether or not it exists yet. */
  entryPath: string
  /** Absolute path of the icon, when one is set and present on disk. */
  iconPath?: string
  /**
   * The icon as the renderer can load it. A `file://` image is blocked in the
   * app window, so it goes through the `aipg-media` scheme, whose `games`
   * authority serves this library (see `aipgMediaRoots` in main.ts).
   */
  iconUrl?: string
}

const METADATA_FILE = 'game.json'
const HUB_FILE = 'index.html'
const MANIFEST_FILE = 'library.json'

const MAX_SLUG_LENGTH = 40
const MAX_PROVISIONAL_WORDS = 6

/**
 * Folder name for a game: lowercase words joined by dashes, short enough to stay
 * readable in a file dialog and cut between words rather than mid-word (the name
 * is often a whole sentence the user typed). Anything that slugs to nothing
 * (emoji-only, CJK) falls back to a generic name, which the collision suffix then
 * makes unique.
 */
export function slugify(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
  const kept: string[] = []
  for (const word of words) {
    const length = kept.reduce((total, part) => total + part.length + 1, -1)
    if (kept.length > 0 && length + 1 + word.length > MAX_SLUG_LENGTH) break
    kept.push(word)
  }
  return kept.join('-').slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') || 'game'
}

/**
 * A provisional title from the request that started the game ("a one-button
 * endless runner where I dodge asteroids" → "a one-button endless runner…"). It
 * shows in the game bar until the agent replaces it with a real one via the
 * `game` tool, so it only has to be short and recognizable.
 */
export function provisionalName(request: string): string {
  const words = request.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'New game'
  const kept = words.slice(0, MAX_PROVISIONAL_WORDS).join(' ')
  return kept.length < request.trim().length ? `${kept}…` : kept
}

function shortId(): string {
  return Math.random().toString(16).slice(2, 6)
}

function metadataPath(dir: string): string {
  return path.join(dir, METADATA_FILE)
}

function readMetadata(dir: string): GameMetadata | null {
  try {
    const parsed = GameMetadataSchema.safeParse(
      JSON.parse(fs.readFileSync(metadataPath(dir), 'utf-8')),
    )
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

function toEntry(dir: string, metadata: GameMetadata): GameEntry {
  const iconPath = metadata.icon ? path.join(dir, metadata.icon) : undefined
  const hasIcon = !!iconPath && fs.existsSync(iconPath)
  return {
    ...metadata,
    dir,
    entryPath: path.join(dir, metadata.entry),
    iconPath: hasIcon ? iconPath : undefined,
    // Every game folder sits directly under the library root, so the URL path is
    // the folder name plus the folder-relative icon.
    iconUrl: hasIcon
      ? `aipg-media://games/${encodeURIComponent(path.basename(dir))}/${metadata
          .icon!.split(/[/\\]/)
          .map(encodeURIComponent)
          .join('/')}`
      : undefined,
  }
}

function writeMetadata(dir: string, metadata: GameMetadata): GameEntry {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(metadataPath(dir), `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8')
  return toEntry(dir, metadata)
}

/**
 * Create a game folder, its `game.json` and the scaffold the agent builds on.
 * The name is a starting point (usually the user's first prompt); the agent
 * replaces it with a real title later.
 *
 * `scaffold: false` leaves the folder empty apart from the card, for a preset
 * whose agent writes the whole game in one go — there a running page it did not
 * write is something to work around rather than something to build on.
 */
export function createGame(
  options: { name?: string; description?: string; scaffold?: boolean } = {},
  root: string = getGamesDir(),
): GameEntry {
  const name = options.name?.trim() || 'New game'
  const base = slugify(name)
  let id = base
  // A second "space dodger" gets `space-dodger-3f2a` rather than overwriting the
  // first one's folder.
  while (fs.existsSync(path.join(root, id))) id = `${base}-${shortId()}`
  const now = Date.now()
  const dir = path.join(root, id)
  const game = writeMetadata(dir, {
    id,
    name,
    description: options.description ?? '',
    entry: 'index.html',
    published: false,
    createdAt: now,
    updatedAt: now,
  })
  // The folder is playable from the first second, so the agent starts from a
  // running page it edits rather than from a blank one it has to write out
  // whole (see gameScaffold.ts).
  if (options.scaffold !== false) writeScaffold(dir)
  return game
}

/** The game a folder holds, or null when it is not a game folder. */
export function readGame(dir: string): GameEntry | null {
  const metadata = readMetadata(dir)
  return metadata ? toEntry(dir, metadata) : null
}

/**
 * Patch a game's metadata. Fields the caller does not mention keep their value,
 * and `updatedAt` is always bumped so the library sorts by recent work.
 */
export function updateGame(
  dir: string,
  patch: Partial<Omit<GameMetadata, 'id' | 'createdAt'>>,
): GameEntry {
  const current = readMetadata(dir)
  if (!current) throw new Error(`Not a game folder: ${dir}`)
  return writeMetadata(dir, { ...current, ...patch, updatedAt: Date.now() })
}

/**
 * Adopt a generated image as the game's icon. The source must already be inside
 * the game folder (the agent generates into `generated/`); it is copied to
 * `icon.<ext>` so the icon survives a cleanup of the generated art.
 */
export function setGameIcon(dir: string, relativePath: string): GameEntry {
  const source = path.resolve(dir, relativePath)
  const inside = path.relative(dir, source)
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`Icon must be a file inside the game folder, got '${relativePath}'.`)
  }
  if (!fs.existsSync(source)) throw new Error(`Icon file does not exist: ${relativePath}`)
  const icon = `icon${path.extname(source).toLowerCase() || '.png'}`
  const target = path.join(dir, icon)
  if (path.resolve(target) !== source) fs.copyFileSync(source, target)
  return updateGame(dir, { icon })
}

/** Every game in the library, most recently worked on first. */
export function listGames(root: string = getGamesDir()): GameEntry[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readGame(path.join(root, entry.name)))
    .filter((game): game is GameEntry => game !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Save a draft into the library: name and description as the user confirmed them,
 * `published` on, and the hub page regenerated so it shows the new game.
 */
export function publishGame(
  dir: string,
  fields: { name?: string; description?: string } = {},
  hub: HubOptions = {},
): GameEntry {
  const published = updateGame(dir, {
    ...(fields.name?.trim() ? { name: fields.name.trim() } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    published: true,
  })
  writeHub(hub)
  return published
}

/**
 * JSON for a `<script>` block. A game name is whatever the model or the user
 * typed, and an unescaped `<` in it would end the block early ('</script>' in a
 * title) and turn the rest of the manifest into markup. `\u003c` parses as the
 * same string but is inert to the HTML parser.
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** What the hub page and the (Q4) portal upload both read. */
export type GameManifestEntry = {
  id: string
  name: string
  description: string
  /** Root-relative path, so the manifest works from the hub page as-is. */
  entry: string
  icon?: string
  createdAt: number
  updatedAt: number
}

export type HubOptions = {
  root?: string
  /** OEM the page is branded for; only 'acer' currently changes anything. */
  vendor?: string
}

function manifestOf(games: GameEntry[]): GameManifestEntry[] {
  return games.map((game) => ({
    id: game.id,
    name: game.name,
    description: game.description,
    entry: `${game.id}/${game.entry}`,
    icon: game.icon ? `${game.id}/${game.icon}` : undefined,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
  }))
}

/**
 * Write the gallery page plus the manifest it is built from.
 *
 * The manifest is inlined into the page instead of fetched: the hub is opened as
 * a `file://` URL, where `fetch` of a sibling file is blocked, and it has to work
 * with AI Playground closed. `library.json` is written next to it anyway — it is
 * the stable input for uploading a library to the social portal later.
 */
export function writeHub(options: HubOptions = {}): { hubPath: string; manifestPath: string } {
  const root = options.root ?? getGamesDir()
  fs.mkdirSync(root, { recursive: true })
  const games = manifestOf(listGames(root).filter((game) => game.published))
  const manifestPath = path.join(root, MANIFEST_FILE)
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ generatedAt: Date.now(), vendor: options.vendor ?? null, games }, null, 2)}\n`,
    'utf-8',
  )
  const hubPath = path.join(root, HUB_FILE)
  fs.writeFileSync(hubPath, hubHtml(games, options.vendor), 'utf-8')
  return { hubPath, manifestPath }
}

function hubHtml(games: GameManifestEntry[], vendor?: string): string {
  const isAcer = vendor?.toLowerCase() === 'acer'
  const title = isAcer ? 'Acer Game Hub' : 'My Games'
  const accent = isAcer ? '#83b81a' : '#4f8cff'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --accent: ${accent}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 48px 32px 64px;
    font: 16px/1.5 "Segoe UI", system-ui, sans-serif; color: #f2f4f8;
    background: radial-gradient(circle at 15% -10%, #1d2740 0%, #0a0d14 55%, #05070b 100%);
  }
  header { max-width: 1180px; margin: 0 auto 40px; }
  h1 { margin: 0; font-size: 2.4rem; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  p.lead { margin: 8px 0 0; color: #9aa4b8; }
  ul.games {
    max-width: 1180px; margin: 0 auto; padding: 0; list-style: none;
    display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
  li.game {
    background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px; overflow: hidden; transition: transform .15s ease, border-color .15s ease;
  }
  li.game:hover { transform: translateY(-3px); border-color: var(--accent); }
  li.game a { display: block; color: inherit; text-decoration: none; }
  .cover { aspect-ratio: 1 / 1; background: #131826 center/cover no-repeat; display: grid; place-items: center; }
  .cover span { font-size: 2.6rem; opacity: .35; }
  .meta { padding: 14px 16px 18px; }
  .meta h2 { margin: 0 0 6px; font-size: 1.05rem; }
  .meta p { margin: 0; font-size: .875rem; color: #9aa4b8; }
  .empty { max-width: 1180px; margin: 0 auto; color: #9aa4b8; }
</style>
</head>
<body>
<header>
  <h1>${isAcer ? 'Acer <span>Game Hub</span>' : 'My <span>Games</span>'}</h1>
  <p class="lead">Games you made with AI Playground. Click one to play.</p>
</header>
<ul class="games" id="games"></ul>
<p class="empty" id="empty" hidden>No games saved yet — build one in AI Playground's Game Maker.</p>
<!-- Inlined on purpose: a file:// page cannot fetch its own library.json, and the
     hub has to work with AI Playground closed. -->
<script type="application/json" id="library">${inlineJson(games)}</script>
<script>
  const games = JSON.parse(document.getElementById('library').textContent)
  const list = document.getElementById('games')
  if (games.length === 0) document.getElementById('empty').hidden = false
  for (const game of games) {
    const item = document.createElement('li')
    item.className = 'game'
    const link = document.createElement('a')
    link.href = game.entry
    const cover = document.createElement('div')
    cover.className = 'cover'
    if (game.icon) cover.style.backgroundImage = 'url("' + game.icon + '")'
    else cover.innerHTML = '<span>🎮</span>'
    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('h2')
    name.textContent = game.name
    const description = document.createElement('p')
    description.textContent = game.description
    meta.append(name, description)
    link.append(cover, meta)
    item.append(link)
    list.append(item)
  }
</script>
</body>
</html>
`
}
