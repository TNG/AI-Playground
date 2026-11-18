#!/usr/bin/env node
/**
 * Runs electron-builder with `INSTALLER_ID` set, which `artifactName` expands
 * into the installer filename (see build-config.json).
 *
 * It is a script rather than an npm-script prefix because electron-builder
 * *throws* on an unset `${env.…}` macro, and there is no portable way to compute
 * the value inline for both cmd.exe and sh.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveBuildIdentity } from './buildIdentity.mts'
import { nativeRebuildArgs } from './nativeRebuild.mts'

const windowsHasMsvc = () => {
  const programFiles = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return false
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  )
  return found.status === 0 && Boolean(found.stdout?.trim())
}

const identity = resolveBuildIdentity()
console.log(
  `📦 installer id: ${identity.installerId}` +
    ` (commit ${identity.commit || 'unknown'}${identity.tag ? `, tag ${identity.tag}` : ''})`,
)

const rebuild = nativeRebuildArgs({
  platform: process.platform,
  forced: process.env.AIPG_NPM_REBUILD,
  hasMsvc: process.platform === 'win32' ? windowsHasMsvc() : true,
})
if (rebuild.notice) console.log(rebuild.notice)

const result = spawnSync('electron-builder', [...process.argv.slice(2), ...rebuild.args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, INSTALLER_ID: identity.installerId },
})

if (result.error) {
  console.error('❌ Failed to run electron-builder:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
