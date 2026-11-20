import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importAttachment,
  attachmentsSeenBy,
  resolveWorkspaceFile,
  turnAttachments,
  withAttachmentReferences,
} from '../../agent/workspaceAttachments.ts'

// Attaching a file to an agent turn copies it into the workspace, so the agent can
// reach it with its own file tools. The name comes from the renderer, so these
// tests are mostly about it not being trusted.

let workspace: string

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-attachments-')))
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

const bytes = (text: string) => new Uint8Array(Buffer.from(text))
const gameFolder = () => ({ dir: path.join(workspace, 'attachments'), reference: 'attachments' })

describe('importAttachment', () => {
  it('saves the file and returns a workspace-relative path', () => {
    const result = importAttachment(gameFolder(), 'player.png', bytes('sprite'))

    expect(result.path).toBe('attachments/player.png')
    expect(fs.readFileSync(path.join(workspace, result.path), 'utf8')).toBe('sprite')
  })

  it('keeps both files when two share a name', () => {
    const first = importAttachment(gameFolder(), 'sprite.png', bytes('one'))
    const second = importAttachment(gameFolder(), 'sprite.png', bytes('two'))

    expect([first.path, second.path]).toEqual([
      'attachments/sprite.png',
      'attachments/sprite-2.png',
    ])
    expect(fs.readFileSync(path.join(workspace, first.path), 'utf8')).toBe('one')
  })

  it.each([
    ['../../escape.txt', 'escape.txt'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Windows\\evil.exe', 'evil.exe'],
    ['..', 'attachment'],
  ])('strips the path out of %s', (name, expected) => {
    const result = importAttachment(gameFolder(), name, bytes('x'))

    expect(result.path).toBe(`attachments/${expected}`)
    expect(fs.existsSync(path.join(workspace, 'attachments', expected))).toBe(true)
  })

  it('creates the attachments folder on first use', () => {
    expect(fs.existsSync(path.join(workspace, 'attachments'))).toBe(false)

    importAttachment(gameFolder(), 'notes.txt', bytes('hello'))

    expect(fs.existsSync(path.join(workspace, 'attachments'))).toBe(true)
  })
})

describe("a Session's attachments outside its Workspace", () => {
  let internal: string
  const sessionFolder = () => ({ dir: internal, reference: '/attachments' })

  beforeEach(() => {
    internal = path.join(workspace, '..', `internal-${path.basename(workspace)}`)
  })

  afterEach(() => {
    fs.rmSync(internal, { recursive: true, force: true })
  })

  it('reach a vision model through the @/attachments/ reference', () => {
    const saved = importAttachment(sessionFolder(), 'cat.png', bytes('pixels'))
    expect(saved.path).toBe('/attachments/cat.png')
    fs.mkdirSync(path.join(workspace, 'attachments'))
    fs.writeFileSync(path.join(workspace, 'attachments', 'stale.png'), 'old')
    fs.writeFileSync(path.join(workspace, 'cover.png'), 'artifact')
    const files = { workspaceDir: workspace, attachmentsDir: internal }

    const { images } = turnAttachments(
      files,
      `look at @${saved.path} and @attachments/stale.png and @cover.png`,
      true,
    )

    expect(images.map((image) => Buffer.from(image.data, 'base64').toString())).toEqual(['pixels'])
  })

  it('are what a tool given /attachments/<file>, their real path or the old name reads', () => {
    importAttachment(sessionFolder(), 'note.wav', bytes('riff'))
    fs.writeFileSync(path.join(workspace, 'out.wav'), 'artifact')
    const files = { workspaceDir: workspace, attachmentsDir: internal }

    expect(fs.readFileSync(resolveWorkspaceFile(files, 'attachments/note.wav'), 'utf8')).toBe(
      'riff',
    )
    expect(fs.readFileSync(resolveWorkspaceFile(files, '/attachments/note.wav'), 'utf8')).toBe(
      'riff',
    )
    expect(
      fs.readFileSync(resolveWorkspaceFile(files, path.join(internal, 'note.wav')), 'utf8'),
    ).toBe('riff')
    expect(fs.readFileSync(resolveWorkspaceFile(files, 'out.wav'), 'utf8')).toBe('artifact')
    expect(() => resolveWorkspaceFile(files, '/attachments/../escape.wav')).toThrow()
    expect(() => resolveWorkspaceFile(files, 'attachments/../../escape.wav')).toThrow()
  })
})

describe('a real-shell turn', () => {
  it('is told the real path of the attachments instead of /attachments', () => {
    const folder = attachmentsSeenBy(
      { dir: '/data/s1/attachments', reference: '/attachments' },
      true,
    )

    expect(
      withAttachmentReferences('see @/attachments/a.png and @"/attachments/b c.pdf"', folder),
    ).toBe('see @/data/s1/attachments/a.png and @"/data/s1/attachments/b c.pdf"')
  })

  it('leaves a sandboxed turn and a game alone', () => {
    const session = { dir: '/data/s1/attachments', reference: '/attachments' }
    const game = { dir: '/games/g/attachments', reference: 'attachments' }

    expect(attachmentsSeenBy(session, false)).toEqual(session)
    expect(attachmentsSeenBy(game, true)).toEqual(game)
    expect(withAttachmentReferences('@/attachments/a.png', session)).toBe('@/attachments/a.png')
  })
})
