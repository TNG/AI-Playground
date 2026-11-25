import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createFreeFolder, freeName, mergeInto, nextNumberedName, renameToFree } =
  await import('../../persist/fileOps')

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-file-ops-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe('a free name', () => {
  it('counts with a dash for a Session file', async () => {
    await write(path.join(root, 'cat.png'), 'a')
    await write(path.join(root, 'cat-1.png'), 'b')

    expect(await freeName(root, 'cat.png')).toBe('cat-2.png')
    expect(await freeName(root, 'new.png')).toBe('new.png')
  })

  it('makes a folder under the first free name', async () => {
    await fs.mkdir(path.join(root, '2026-11-19 Cat poster'))

    expect(await createFreeFolder(root, '2026-11-19 Cat poster')).toBe(
      path.join(root, '2026-11-19 Cat poster (2)'),
    )
  })

  it('renames a folder beside itself, skipping a name another folder has', async () => {
    await fs.mkdir(path.join(root, 'old'))
    await fs.mkdir(path.join(root, 'taken'))

    expect(await renameToFree(path.join(root, 'old'), 'taken')).toBe(path.join(root, 'taken (2)'))
  })
})

describe('the next number in a series', () => {
  it('starts at 1 in an empty folder, keeping the incoming prefix', async () => {
    expect(await nextNumberedName(root, 'AIPG_Image_00042_.png')).toBe('AIPG_Image_00001_.png')
  })

  it('continues the series already in the folder', async () => {
    await write(path.join(root, 'AIPG_Image_00003_.png'), 'a')

    expect(await nextNumberedName(root, 'AIPG_Image_00001_.png')).toBe('AIPG_Image_00004_.png')
  })

  it('ignores dash-suffixed siblings from before the series when finding the maximum', async () => {
    await write(path.join(root, 'AIPG_Image_00001_.png'), 'a')
    await write(path.join(root, 'AIPG_Image_00001_-1.png'), 'b')

    expect(await nextNumberedName(root, 'AIPG_Image_00001_.png')).toBe('AIPG_Image_00002_.png')
  })

  it('numbers each prefix on its own', async () => {
    await write(path.join(root, 'AIPG_Image_00002_.png'), 'a')

    expect(await nextNumberedName(root, 'AIPG_Video_00001_.mp4')).toBe('AIPG_Video_00001_.mp4')
  })

  it('falls back to a free dash-numbered name for anything not a series', async () => {
    await write(path.join(root, 'fox.png'), 'a')

    expect(await nextNumberedName(root, 'fox.png')).toBe('fox-1.png')
  })
})

describe('merging a folder into another', () => {
  it('keeps what already arrived, renames what differs, and removes the emptied source', async () => {
    const from = path.join(root, 'from')
    const to = path.join(root, 'to')
    await write(path.join(from, 'same.txt'), 'same')
    await write(path.join(to, 'same.txt'), 'same')
    await write(path.join(from, 'clash.txt'), 'new')
    await write(path.join(to, 'clash.txt'), 'old')
    await write(path.join(from, 'sub', 'deep.txt'), 'deep')
    await write(path.join(from, '.DS_Store'), 'litter')

    expect(await mergeInto(from, to)).toBe(2)

    expect((await fs.readdir(to)).sort()).toEqual(['clash-1.txt', 'clash.txt', 'same.txt', 'sub'])
    expect(await fs.readFile(path.join(to, 'clash-1.txt'), 'utf8')).toBe('new')
    expect(await fs.readFile(path.join(to, 'sub', 'deep.txt'), 'utf8')).toBe('deep')
    await expect(fs.access(from)).rejects.toThrow()
  })

  it('moves nothing from a folder that is not there', async () => {
    expect(await mergeInto(path.join(root, 'missing'), path.join(root, 'to'))).toBe(0)
  })
})
