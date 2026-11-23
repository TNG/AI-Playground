import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The `game` tool is how the agent fills in the library card (title, description,
// cover) for the game it is building. It writes through gameLibrary against the
// real filesystem here — that round trip is the point — with Electron and Pi
// mocked away.

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-game-tool-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => agentDir, getAppPath: () => agentDir },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const { gameStudioCapability } = await import('../../agent/capabilities/gameStudio.ts')
const { createGame, readGame } = await import('../../agent/games/gameLibrary.ts')
const { noteGeneratedMedia, resetGeneratedMediaForTest } =
  await import('../../agent/generatedMedia.ts')

type GameTool = {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

const MEDIA_SPEC = { name: 'media', description: 'media', inputSchema: {} }

function hostFor(workspaceDir: string) {
  return {
    sessionId: 'session-1',
    workspaceDir,
    agentDir,
    toolSpecs: [MEDIA_SPEC],
  } as unknown as Parameters<NonNullable<typeof gameStudioCapability.buildTools>>[0]
}

async function gameToolFor(workspaceDir: string): Promise<GameTool> {
  const tools = await gameStudioCapability.buildTools!(hostFor(workspaceDir))
  return tools[0] as unknown as GameTool
}

function writeWorkspaceFile(relativePath: string): void {
  const file = path.join(workspaceDir, relativePath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'png')
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content ?? [])
    .map((part) => part.text)
    .join('\n')
}

let root: string
let workspaceDir: string

beforeEach(() => {
  resetGeneratedMediaForTest()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-games-'))
  workspaceDir = createGame({ name: 'a game about dodging' }, root).dir
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('game tool', () => {
  it('is offered as one small tool alongside the skill', async () => {
    const tool = await gameToolFor(workspaceDir)
    expect(tool.name).toBe('game')
    const skills = await gameStudioCapability.buildSkills!(hostFor(workspaceDir))
    expect(skills.map((skill) => skill.name)).toEqual(['html-game-studio'])
    // Deferring it would cost a round trip right at the end of the task.
    expect(gameStudioCapability.lazyEligible).toBe(false)
  })

  it('names the media tool the turn actually shipped, and no example filename', async () => {
    const delegated = await gameStudioCapability.buildSkills!(hostFor(workspaceDir))
    expect(delegated[0].body).toContain('`media`')
    // An example path reads like a result the model already has; it passed that
    // example to set_icon instead of generating anything.
    expect(delegated[0].body).not.toMatch(/AIPG_\d+_/)

    const direct = await gameStudioCapability.buildSkills!({
      ...hostFor(workspaceDir),
      toolSpecs: [
        { name: 'generateImage', description: '', inputSchema: {} },
        { name: 'editImage', description: '', inputSchema: {} },
      ],
    } as unknown as Parameters<NonNullable<typeof gameStudioCapability.buildSkills>>[0])
    expect(direct[0].body).toContain('`generateImage`')
    expect(direct[0].body).not.toContain('`media`')
  })

  it('names and describes the game', async () => {
    const tool = await gameToolFor(workspaceDir)
    const result = await tool.execute('call-1', {
      action: 'set_metadata',
      name: 'Space Dodger',
      description: 'Dodge asteroids for as long as you can.',
    })
    expect(textOf(result)).toContain('Space Dodger')
    expect(readGame(workspaceDir)).toMatchObject({
      name: 'Space Dodger',
      description: 'Dodge asteroids for as long as you can.',
    })
  })

  it('sets the description without clearing the name', async () => {
    const tool = await gameToolFor(workspaceDir)
    await tool.execute('call-1', { action: 'set_metadata', name: 'Space Dodger' })
    await tool.execute('call-2', { action: 'set_metadata', description: 'Dodge asteroids.' })
    expect(readGame(workspaceDir)).toMatchObject({
      name: 'Space Dodger',
      description: 'Dodge asteroids.',
    })
  })

  it('asks for something to write when told nothing', async () => {
    const tool = await gameToolFor(workspaceDir)
    const result = await tool.execute('call-1', { action: 'set_metadata' })
    expect(textOf(result)).toMatch(/Provide a name/)
  })

  it('adopts generated art as the cover', async () => {
    writeWorkspaceFile('generated/AIPG_00002_.png')
    noteGeneratedMedia(workspaceDir, ['generated/AIPG_00002_.png'])
    const tool = await gameToolFor(workspaceDir)
    const result = await tool.execute('call-1', {
      action: 'set_icon',
      path: 'generated/AIPG_00002_.png',
    })
    expect(textOf(result)).toContain('icon.png')
    expect(readGame(workspaceDir)?.icon).toBe('icon.png')
  })

  it('takes art the user brought', async () => {
    writeWorkspaceFile('attachments/ship.png')
    const tool = await gameToolFor(workspaceDir)
    await tool.execute('call-1', { action: 'set_icon', path: 'attachments/ship.png' })
    expect(readGame(workspaceDir)?.icon).toBe('icon.png')
  })

  it('refuses a cover no media call produced, and says how to get one', async () => {
    // The failure this guards: the model passed the example path from its
    // instructions, then wrote a file at that path with the shell.
    writeWorkspaceFile('generated/AIPG_00001_.png')
    const tool = await gameToolFor(workspaceDir)
    const result = textOf(
      await tool.execute('call-1', { action: 'set_icon', path: 'generated/AIPG_00001_.png' }),
    )
    expect(result).toMatch(/not an image this session produced/)
    expect(result).toContain('`media`')
    expect(readGame(workspaceDir)?.icon).toBeUndefined()
  })

  it('tells the model what went wrong instead of throwing', async () => {
    const tool = await gameToolFor(workspaceDir)
    expect(textOf(await tool.execute('call-1', { action: 'set_icon' }))).toMatch(/Provide the path/)
    noteGeneratedMedia(workspaceDir, ['generated/missing.png'])
    expect(
      textOf(await tool.execute('call-2', { action: 'set_icon', path: 'generated/missing.png' })),
    ).toMatch(/does not exist/)
    expect(
      textOf(await tool.execute('call-3', { action: 'set_icon', path: '../escape.png' })),
    ).toMatch(/not an image this session produced/)
  })

  it('reads the card back, including whether the user saved it', async () => {
    const tool = await gameToolFor(workspaceDir)
    await tool.execute('call-1', { action: 'set_metadata', name: 'Space Dodger' })
    const result = textOf(await tool.execute('call-2', { action: 'get' }))
    expect(result).toContain('name: Space Dodger')
    expect(result).toContain('saved to library: not yet')
  })

  it('explains itself in a workspace that is not a game', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-plain-'))
    try {
      const tool = await gameToolFor(plain)
      const result = await tool.execute('call-1', { action: 'set_metadata', name: 'Nope' })
      expect(textOf(result)).toMatch(/not a game folder/i)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

// 3D games load three.js and generated models as classic scripts, because a game
// is played as a file:// page where ES modules and fetch() of a .glb are blocked.
describe('game tool, 3D models', () => {
  const GLB = Buffer.from('glTF\x02\x00\x00\x00 not really a model', 'binary')

  function writeModel(relativePath: string): void {
    const file = path.join(workspaceDir, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, GLB)
  }

  it('turns the untouched scaffold into a running 3D one, with three.js beside it', async () => {
    const tool = await gameToolFor(workspaceDir)
    const result = textOf(await tool.execute('call-1', { action: 'add_threejs' }))
    expect(result).toMatch(/now holds the 3D scaffold/)
    expect(fs.readFileSync(path.join(workspaceDir, 'game.js'), 'utf-8')).toContain(
      'new THREE.WebGLRenderer',
    )
    expect(fs.readFileSync(path.join(workspaceDir, 'lib/three-game.js'), 'utf-8')).toMatch(
      /^\/\* three\.js r\d+ with GLTFLoader/,
    )
  })

  it('only adds three.js to a game the agent already changed, and says what to do', async () => {
    fs.appendFileSync(path.join(workspaceDir, 'game.js'), '\n// edited\n')
    const tool = await gameToolFor(workspaceDir)
    const result = textOf(await tool.execute('call-1', { action: 'add_threejs' }))
    expect(result).toContain('<script src="lib/three-game.js"></script>')
    expect(result).toMatch(/getContext\('2d'\)/)
    expect(fs.readFileSync(path.join(workspaceDir, 'game.js'), 'utf-8')).toContain('// edited')
  })

  it('embeds a generated model as a classic script the game can load', async () => {
    writeModel('generated/AIPG_3D_00001_.glb')
    noteGeneratedMedia(workspaceDir, ['generated/AIPG_3D_00001_.glb'])
    const tool = await gameToolFor(workspaceDir)

    const result = textOf(
      await tool.execute('call-1', {
        action: 'import_model',
        path: 'generated/AIPG_3D_00001_.glb',
        modelName: 'enemy',
      }),
    )

    expect(result).toContain('<script src="models/enemy.js"></script>')
    expect(result).toContain('MODELS map')
    expect(result).toContain("THREE.loadGameModel('enemy')")
    expect(fs.existsSync(path.join(workspaceDir, 'lib/three-game.js'))).toBe(true)
    const script = fs.readFileSync(path.join(workspaceDir, 'models/enemy.js'), 'utf-8')
    const models: Record<string, string> = {}
    new Function('window', script)({ GAME_MODELS: models })
    expect(Buffer.from(models.enemy, 'base64').equals(GLB)).toBe(true)
  })

  it('refuses a model no media call produced', async () => {
    writeModel('generated/made-up.glb')
    const tool = await gameToolFor(workspaceDir)
    const result = textOf(
      await tool.execute('call-1', {
        action: 'import_model',
        path: 'generated/made-up.glb',
        modelName: 'enemy',
      }),
    )
    expect(result).toMatch(/not a model this session produced/)
    expect(fs.existsSync(path.join(workspaceDir, 'models/enemy.js'))).toBe(false)
  })

  it('says what is wrong with a bad name or file instead of throwing', async () => {
    writeModel('attachments/ship.glb')
    fs.writeFileSync(path.join(workspaceDir, 'attachments/ship.png'), 'png')
    const tool = await gameToolFor(workspaceDir)
    const run = async (params: Record<string, unknown>) =>
      textOf(await tool.execute('call-1', { action: 'import_model', ...params }))

    expect(await run({ path: 'attachments/ship.glb' })).toMatch(/modelName/)
    expect(await run({ path: 'attachments/ship.glb', modelName: 'Big Ship' })).toMatch(
      /cannot be a model name/,
    )
    expect(await run({ path: 'attachments/ship.png', modelName: 'ship' })).toMatch(/not a \.glb/)
    expect(await run({ path: 'attachments/ship.glb', modelName: 'ship' })).toContain(
      'models/ship.js',
    )
  })
})
