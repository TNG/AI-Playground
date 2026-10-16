import type {
  PermissionsInvokeName,
  PermissionsSendName,
  InvokeHandlerMap,
  SendHandlerMap,
} from '../ipcRegistries'
import type { setAwaitingUser } from '../userWait'
import type { PauseReason } from '@/types/kernelEvents'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type { handlePermissionsPromptResponse } from '../../permissions/promptAdapter'
import type {
  grant as grantPermission,
  listGrants,
  migrateGrants,
  requestDownloadConsent,
  requestVramWarningConsent,
  revoke as revokePermission,
} from '../../permissions/permissionsService'

/** The consent-policy and prompt seams the seven permissions handlers close over. */
export type PermissionsDeps = {
  requestDownloadConsent: typeof requestDownloadConsent
  requestVramWarningConsent: typeof requestVramWarningConsent
  listGrants: typeof listGrants
  grantPermission: typeof grantPermission
  revokePermission: typeof revokePermission
  migrateGrants: typeof migrateGrants
  handlePermissionsPromptResponse: typeof handlePermissionsPromptResponse
}

export function buildPermissionsRegistry(deps: PermissionsDeps) {
  return {
    'permissions:requestDownload': async (_event, models) => {
      try {
        if (!Array.isArray(models)) throw new Error('download models must be an array')
        await deps.requestDownloadConsent(models)
        return { success: true as const }
      } catch (e) {
        return {
          success: false as const,
          error: ipcErrorText(e),
          cancelled: (e as { cancelled?: boolean })?.cancelled === true,
        }
      }
    },
    'permissions:requestVramWarning': async (_event, req) => {
      try {
        if (typeof req?.presetName !== 'string' || typeof req?.message !== 'string') {
          throw new Error('vram warning request needs presetName and message')
        }
        const confirmed = await deps.requestVramWarningConsent({
          presetName: req.presetName,
          message: req.message,
        })
        return { success: true as const, confirmed }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'permissions:list': async () => {
      try {
        return { success: true as const, grants: await deps.listGrants() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'permissions:grant': async (_event, key, origin) => {
      try {
        if (typeof key !== 'string') throw new Error('grant key must be a string')
        if (origin !== 'remember' && origin !== 'pre-grant') {
          throw new Error('grant origin must be remember or pre-grant')
        }
        const grant = await deps.grantPermission(key, origin)
        return { success: true as const, grant }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'permissions:revoke': async (_event, key) => {
      try {
        if (typeof key !== 'string') throw new Error('grant key must be a string')
        await deps.revokePermission(key)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'permissions:migrate': async (_event, incoming) => {
      try {
        if (!incoming || typeof incoming !== 'object') {
          throw new Error('migrate payload must be an object')
        }
        await deps.migrateGrants(incoming)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'permissions:respond': (_event, payload) => {
      deps.handlePermissionsPromptResponse(payload)
    },
  } satisfies InvokeHandlerMap<PermissionsInvokeName>
}

const PAUSE_KINDS = Object.keys({
  download: true,
  'vram-warning': true,
  confirmation: true,
  question: true,
} satisfies Record<PauseReason['kind'], true>)

function validPauseReason(reason: unknown): PauseReason | undefined {
  const { kind, summary } = (reason ?? {}) as { kind?: unknown; summary?: unknown }
  if (typeof kind !== 'string' || !PAUSE_KINDS.includes(kind)) return undefined
  return typeof summary === 'string' && summary
    ? { kind: kind as PauseReason['kind'], summary: summary.slice(0, 200) }
    : { kind: kind as PauseReason['kind'] }
}

export function buildPermissionsSendRegistry(deps: { setAwaitingUser: typeof setAwaitingUser }) {
  return {
    'permissions:awaitingUser': (_event, conversationKey, waiting, reason) => {
      if (typeof conversationKey !== 'string' || typeof waiting !== 'boolean') return
      deps.setAwaitingUser(conversationKey, waiting, waiting ? validPauseReason(reason) : undefined)
    },
  } satisfies SendHandlerMap<PermissionsSendName>
}
