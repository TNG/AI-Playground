import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importAttachment } from '../../agent/workspaceAttachments.ts'
import {
  documentsLine,
  removeSessionDocument,
  sessionDocuments,
} from '../../agent/sessionDocuments.ts'

describe('removing a Session document', () => {
  let workspace: string
  let attachments: { dir: string; reference: string }

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-session-docs-')))
    attachments = { dir: path.join(workspace, 'attachments'), reference: 'attachments' }
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('deletes the copy, so the model is no longer told about it', async () => {
    const original = path.join(workspace, '..', `original-${path.basename(workspace)}.pdf`)
    fs.writeFileSync(original, 'the budget is $42')
    try {
      const saved = importAttachment(attachments, 'report.pdf', fs.readFileSync(original)).path
      importAttachment(attachments, 'notes.md', Buffer.from('# notes'))

      await removeSessionDocument(attachments, saved)

      expect(sessionDocuments(attachments)).toEqual(['attachments/notes.md'])
      expect(documentsLine(attachments)).not.toContain('report.pdf')
      expect(fs.existsSync(original)).toBe(true)
    } finally {
      fs.rmSync(original, { force: true })
    }
  })

  it('refuses anything that is not an attached document', async () => {
    fs.writeFileSync(path.join(workspace, 'game.js'), 'loop()')
    importAttachment(attachments, 'sprite.png', Buffer.from('png'))

    for (const target of [
      'game.js',
      'attachments/sprite.png',
      '../outside.pdf',
      'attachments/gone.pdf',
    ]) {
      await expect(removeSessionDocument(attachments, target)).rejects.toThrow()
    }
    expect(fs.existsSync(path.join(workspace, 'game.js'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, 'attachments', 'sprite.png'))).toBe(true)
  })
})
