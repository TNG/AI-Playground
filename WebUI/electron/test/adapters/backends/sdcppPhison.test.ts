import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import * as filesystem from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSdServerArgs,
  computeSdCppArtifactsReady,
  describeExitCode,
  isInsideWindowsDir,
  parseAdaDitServiceQuery,
  parseSdServerDevices,
  parseSdServerHealth,
  parseSdServerVersion,
  quoteServiceBinaryCommand,
  resolveSdCppImageModels,
  sdcppPackageFiles,
  SDCPP_DEFAULT_PART,
  sdServerPortCandidates,
  waitForServiceRemovalCommand,
} from '../../../adapters/backends/sdcppPhison'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const zImageModels = [
  { type: 'unet', model: 'jayn7/Z-Image-Turbo-GGUF/z_image_turbo-Q4_K_M.gguf' },
  {
    type: 'clip',
    model: 'Comfy-Org/z_image_turbo/split_files/text_encoders/qwen_3_4b.safetensors',
  },
  { type: 'vae', model: 'Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors' },
  { type: 'nsfwdetector', model: 'AdamCodd/vit-base-nsfw-detector/model.safetensors' },
]

describe('sdcppPackageFiles', () => {
  it('lists the host zip first and the SYCL add-on second, on S3, with the release sha256', () => {
    expect(sdcppPackageFiles(SDCPP_DEFAULT_PART, 'sycl')).toEqual([
      {
        url: 'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/NXWIH602T2_x64.zip',
        fileName: 'NXWIH602T2_x64.zip',
        sha256: 'ba46e2441f3d5ee1b3a8e567d5c87c27bfdf41cb60be1c11795d0462d5e495c4',
      },
      {
        url: 'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/NXWIH602T2_x64_addon-sycl.zip',
        fileName: 'NXWIH602T2_x64_addon-sycl.zip',
        sha256: '6b5b9470b089d7c355809784cfc1482917d556e2b1619cdbf0c6e8c7e092fd3a',
      },
    ])
  })

  it('joins another base URL with one slash', () => {
    expect(sdcppPackageFiles('NXWIH602T2', 'sycl', 'https://mirror.test/pkgs/')[0]!.url).toBe(
      'https://mirror.test/pkgs/NXWIH602T2_x64.zip',
    )
  })

  it('pins no checksum for a part number it has not seen', () => {
    const files = sdcppPackageFiles('NXWIH999.9', 'sycl')
    expect(files.map((f) => f.fileName)).toEqual([
      'NXWIH999.9_x64.zip',
      'NXWIH999.9_x64_addon-sycl.zip',
    ])
    expect(files.every((f) => f.sha256 === undefined)).toBe(true)
  })
})

describe('resolveSdCppImageModels', () => {
  const modelDir = (type: string) => ({ unet: 'U', clip: 'C', vae: 'V' })[type]

  it('maps the Z-Image weights to the three sd-server roles under their download folders', () => {
    expect(resolveSdCppImageModels(zImageModels, modelDir)).toEqual({
      diffusionModel: path.join('U', 'jayn7---Z-Image-Turbo-GGUF', 'z_image_turbo-Q4_K_M.gguf'),
      llm: path.join(
        'C',
        'Comfy-Org---z_image_turbo',
        'split_files',
        'text_encoders',
        'qwen_3_4b.safetensors',
      ),
      vae: path.join('V', 'Comfy-Org---z_image_turbo', 'split_files', 'vae', 'ae.safetensors'),
    })
  })

  it('names the role that has no weight', () => {
    expect(
      resolveSdCppImageModels(
        zImageModels.filter((m) => m.type !== 'vae'),
        modelDir,
      ),
    ).toEqual({ missing: ['vae'] })
  })

  it('accepts the diffusion_models and text_encoders folders as well', () => {
    const result = resolveSdCppImageModels(
      [
        { type: 'diffusion_models', model: 'a/b/dit.gguf' },
        { type: 'text_encoders', model: 'a/b/te.safetensors' },
        { type: 'vae', model: 'a/b/vae.safetensors' },
      ],
      (type) => type,
    )
    expect(result).toEqual({
      diffusionModel: path.join('diffusion_models', 'a---b', 'dit.gguf'),
      llm: path.join('text_encoders', 'a---b', 'te.safetensors'),
      vae: path.join('vae', 'a---b', 'vae.safetensors'),
    })
  })
})

describe('sdServerPortCandidates', () => {
  it('offers the whole 46000-46999 range on every start, preferred port first', () => {
    const first = sdServerPortCandidates(46001)
    const second = sdServerPortCandidates(46001)
    expect(first).toHaveLength(1000)
    expect(second).toEqual(first)
    expect(first.slice(0, 3)).toEqual([46001, 46000, 46002])
  })

  it('drops a preferred port outside the range', () => {
    const ports = sdServerPortCandidates(49680)
    expect(ports[0]).toBe(46000)
    expect(ports).not.toContain(49680)
  })
})

describe('buildSdServerArgs', () => {
  const models = { diffusionModel: 'd.gguf', vae: 'v.safetensors', llm: 'l.safetensors' }

  it('starts the shipped exe with the preset, the image weights and a loopback port', () => {
    expect(buildSdServerArgs({ outputDir: 'out', port: 46001, models })).toEqual([
      '--preset',
      '--output-dir',
      'out',
      '--listen-ip',
      '127.0.0.1',
      '--listen-port',
      '46001',
      '--image-diffusion-model',
      'd.gguf',
      '--image-vae',
      'v.safetensors',
      '--image-llm',
      'l.safetensors',
    ])
  })

  it('names the device last when one is selected', () => {
    expect(
      buildSdServerArgs({ outputDir: 'out', port: 1, models, device: 'SYCL0' }).slice(-2),
    ).toEqual(['--device', 'SYCL0'])
  })

  it('names the weight store folder when one is set', () => {
    expect(
      buildSdServerArgs({
        outputDir: 'out',
        port: 1,
        models,
        offloadPath: 'store',
        device: 'SYCL0',
      }).slice(-4),
    ).toEqual(['--offload-path', 'store', '--device', 'SYCL0'])
  })
})

describe('parseSdServerHealth', () => {
  it('is ready on 200 ok', () => {
    expect(parseSdServerHealth(200, '{"status":"ok","device":"SYCL0"}')).toEqual({ state: 'ok' })
  })

  it('keeps waiting while the weights load', () => {
    expect(parseSdServerHealth(503, '{"status":"loading"}')).toEqual({ state: 'loading' })
  })

  it('reports a start-up problem with its code and sentence', () => {
    expect(
      parseSdServerHealth(
        503,
        '{"status":"error","error":{"code":"example_failure","message":"Something went wrong."}}',
      ),
    ).toEqual({
      state: 'error',
      code: 'example_failure',
      message: 'Something went wrong.',
    })
  })

  it('treats an answer it cannot read as still loading', () => {
    expect(parseSdServerHealth(503, 'not json')).toEqual({ state: 'loading' })
  })
})

describe('parseSdServerDevices', () => {
  it('keeps the GPU lines of --list-devices and drops the CPU', () => {
    expect(
      parseSdServerDevices(
        'SYCL0\tIntel(R) Arc(TM) B390 GPU\r\nCPU\tIntel(R) Core(TM) Ultra X7 358H\r\n',
      ),
    ).toEqual([{ id: 'SYCL0', name: 'Intel(R) Arc(TM) B390 GPU' }])
  })
})

describe('parseSdServerVersion', () => {
  it('reads the file version and the part number', () => {
    expect(parseSdServerVersion('sd-server 6.0.2.1 NXWIH602.1\r\n')).toEqual({
      version: '6.0.2.1',
      releaseTag: 'NXWIH602.1',
    })
  })

  it('reads a version whose last part starts with a letter', () => {
    expect(parseSdServerVersion('sd-server 6.0.2T2 NXWIH602T2')).toEqual({
      version: '6.0.2T2',
      releaseTag: 'NXWIH602T2',
    })
  })

  it('returns nothing for other output', () => {
    expect(parseSdServerVersion('usage: sd-server')).toBeUndefined()
  })
})

describe('computeSdCppArtifactsReady', () => {
  it('needs the exe, the SYCL module, the ada_dit files and a finished service step', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sdcpp-phison-'))
    tempDirs.push(dir)
    expect(computeSdCppArtifactsReady(dir)).toBe(false)
    for (const file of ['sd-server.exe', 'ggml-sycl.dll', 'ada_dit.exe']) {
      filesystem.writeFileSync(path.join(dir, file), '')
    }
    filesystem.mkdirSync(path.join(dir, 'scripts'))
    filesystem.writeFileSync(path.join(dir, 'scripts', 'wDitService_create.bat'), '')
    // Extracted, but the UAC prompt was declined: still not installed after a restart.
    expect(computeSdCppArtifactsReady(dir)).toBe(false)
    filesystem.writeFileSync(path.join(dir, 'ada-dit-service.ok'), '')
    expect(computeSdCppArtifactsReady(dir)).toBe(true)
  })
})

const drive = 'C:'

describe('parseAdaDitServiceQuery', () => {
  const packaged = `${drive}\\Programs\\AI Playground\\resources\\sdcpp-phison\\server\\ada_dit.exe`

  it('keeps the spaces of the unquoted path the vendor script registers', () => {
    expect(parseAdaDitServiceQuery(`Running\r\n${packaged}\r\n`)).toEqual({
      running: true,
      binary: packaged,
    })
  })

  it('reads a quoted path and drops arguments after either form', () => {
    expect(parseAdaDitServiceQuery(`Stopped\n"${packaged}" -service`)).toEqual({
      running: false,
      binary: packaged,
    })
    expect(parseAdaDitServiceQuery(`Running\n${drive}\\x\\ada_dit.exe -service`)?.binary).toBe(
      `${drive}\\x\\ada_dit.exe`,
    )
  })

  it('is null when the service is not installed', () => {
    expect(parseAdaDitServiceQuery('')).toBeNull()
    expect(parseAdaDitServiceQuery('\r\n')).toBeNull()
  })
})

describe('isInsideWindowsDir', () => {
  it('ignores case and needs a separator after the folder', () => {
    const server = `${drive}\\x\\server`
    expect(
      isInsideWindowsDir(
        `${drive}\\Apps\\AI Playground\\ada_dit.exe`,
        `${drive.toLowerCase()}\\apps\\ai playground`,
      ),
    ).toBe(true)
    expect(isInsideWindowsDir(`${server}2\\ada_dit.exe`, server)).toBe(false)
    expect(isInsideWindowsDir(server, server)).toBe(false)
    expect(isInsideWindowsDir(`D${server.slice(1)}\\ada_dit.exe`, server)).toBe(false)
  })
})

describe('describeExitCode', () => {
  it('writes Windows status codes in hex, the form their documentation uses', () => {
    expect(describeExitCode(1)).toBe('1')
    expect(describeExitCode(3221225781)).toBe('0xC0000135')
    expect(describeExitCode(-1073741515)).toBe('0xC0000135')
    expect(describeExitCode(null)).toBe('none (killed by a signal)')
  })
})

describe('service batch lines', () => {
  it('stores binPath quoted and escapes what cmd reads outside its quotes', () => {
    expect(quoteServiceBinaryCommand('ada_dit_service', `${drive}\\R&D 100%\\ada_dit.exe`)).toBe(
      `sc.exe config ada_dit_service binPath= "\\"${drive}\\R^&D 100%%\\ada_dit.exe\\""`,
    )
  })

  it('waits at most 30 one-second rounds for a deleted service to leave the list', () => {
    expect(waitForServiceRemovalCommand('ada_dit_service')).toBe(
      'for /l %%i in (1,1,30) do @(sc.exe query ada_dit_service >nul 2>&1 && ping -n 2 127.0.0.1 >nul)',
    )
  })
})
