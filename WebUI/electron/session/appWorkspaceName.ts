// What the app names a Workspace it creates: `<YYYY-MM-DD> <title>`, valid on every OS.

export const UNTITLED_WORKSPACE = 'New session'

const WINDOWS_PATH_LIMIT = 259
const CLASH_SUFFIX_ROOM = ' (99)'.length
const ARTIFACT_NAME_ROOM = 60
const TITLE_MAX = 80
const TITLE_MIN = 8

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g

function trimEnds(name: string): string {
  return name.replace(/^[\s.]+|[\s.]+$/g, '')
}

/** `name` with what Windows, macOS or Linux refuse in a folder name removed or escaped. */
export function safeFolderName(name: string): string {
  const cleaned = trimEnds(name.replace(ILLEGAL, ' ').replace(/\s+/g, ' '))
  const dot = cleaned.indexOf('.')
  const stem = dot === -1 ? cleaned : cleaned.slice(0, dot)
  return RESERVED.test(stem) ? `${stem}_${cleaned.slice(stem.length)}` : cleaned
}

function datePart(createdAt: number): string {
  const date = new Date(createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The folder name under `parentDir`, its title capped so the deepest Artifact path fits Windows. */
export function appWorkspaceName(createdAt: number, title: string, parentDir: string): string {
  const date = datePart(createdAt)
  const room = Math.min(
    TITLE_MAX,
    WINDOWS_PATH_LIMIT -
      parentDir.length -
      1 -
      (date.length + 1) -
      CLASH_SUFFIX_ROOM -
      1 -
      ARTIFACT_NAME_ROOM,
  )
  if (room < TITLE_MIN) return date
  const label = safeFolderName(title) || UNTITLED_WORKSPACE
  return `${date} ${trimEnds(label.slice(0, room))}`
}
