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
import { resolveBuildIdentity } from './buildIdentity.mts'

const identity = resolveBuildIdentity()
console.log(
  `📦 installer id: ${identity.installerId}` +
    ` (commit ${identity.commit || 'unknown'}${identity.tag ? `, tag ${identity.tag}` : ''})`,
)

// node-liblzma's binding.gyp hard-codes -Werror, and gcc warns on Electron 44.10+'s V8 headers;
// node-gyp appends CXXFLAGS after the module's own flags, so this keeps them warnings.
const nativeRebuildEnv =
  process.platform === 'win32'
    ? {}
    : { CXXFLAGS: [process.env.CXXFLAGS, '-Wno-error'].filter(Boolean).join(' ') }

const result = spawnSync('electron-builder', process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ...nativeRebuildEnv, INSTALLER_ID: identity.installerId },
})

if (result.error) {
  console.error('❌ Failed to run electron-builder:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
