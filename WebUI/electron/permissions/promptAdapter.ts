/**
 * Main → renderer request/response for the Permissions dialog adapter (step 13).
 *
 * Policy lives in main; showing the download modal / in-channel prompt / VRAM
 * warning is still a renderer job (the desktop and channel UIs). Same trust
 * direction as `artifact:request`: main asks, the current window answers by
 * requestId. A hidden window still has Chromium, so a Home Agent turn can
 * confirm on the channel the user is on.
 */
import { randomUUID } from 'node:crypto'
import { getKernelEventWindow } from '../kernel/kernelBus'
import { typedSend } from '../kernel/typedIpc'
import type { PermissionsPromptBody, PermissionsPromptResponse } from '@/types/permissionsIpc'

type PendingRequest = {
  requestId: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onProgress?: () => void
  onAnswered?: () => void
}

const pending = new Map<string, PendingRequest>()

export type PromptAdapterOptions = {
  onProgress?: () => void
  /** The user answered; the window is still working on it (a download running). */
  onAnswered?: () => void
  /** The turn the prompt holds up, so the window can show it in that session. */
  conversationKey?: string
  /** Aborting drops the prompt at once, here and in the window. */
  signal?: AbortSignal
}

export const PROMPT_DROPPED = 'The turn that asked has ended.'

export function requestPermissionsPrompt<T>(
  payload: PermissionsPromptBody,
  options: PromptAdapterOptions = {},
): Promise<T> {
  const win = getKernelEventWindow()
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('No renderer window available for the permission prompt'))
  }
  const { signal } = options
  if (signal?.aborted) return Promise.reject(new Error(PROMPT_DROPPED))
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(requestId)) return
      if (!win.isDestroyed())
        typedSend(win.webContents, 'permissions:prompt', { kind: 'drop', requestId })
      reject(new Error(PROMPT_DROPPED))
    }
    const settle =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        signal?.removeEventListener('abort', onAbort)
        fn(...args)
      }
    pending.set(requestId, {
      requestId,
      resolve: settle(resolve as (result: unknown) => void),
      reject: settle(reject),
      onProgress: options.onProgress,
      onAnswered: options.onAnswered,
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      typedSend(win.webContents, 'permissions:prompt', {
        ...payload,
        requestId,
        ...(options.conversationKey ? { conversationKey: options.conversationKey } : {}),
      })
    } catch (error) {
      pending.delete(requestId)
      signal?.removeEventListener('abort', onAbort)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export type CancellableError = Error & { cancelled?: boolean }

/** Keeps "the user declined" distinguishable from "it broke" on the way back. */
function cancellableError(message: string, cancelled: boolean): CancellableError {
  const error: CancellableError = new Error(message)
  if (cancelled) error.cancelled = true
  return error
}

export function handlePermissionsPromptResponse(payload: PermissionsPromptResponse): void {
  if (typeof payload?.requestId !== 'string') return
  const entry = pending.get(payload.requestId)
  if (!entry) return
  if ('progress' in payload) {
    entry.onProgress?.()
    return
  }
  if ('answered' in payload) {
    entry.onAnswered?.()
    return
  }
  pending.delete(payload.requestId)
  if ('error' in payload) {
    entry.reject(cancellableError(payload.error, payload.cancelled === true))
  } else {
    entry.resolve(payload.result)
  }
}

export function rejectAllPermissionPrompts(reason: string): void {
  for (const entry of pending.values()) {
    entry.reject(new Error(reason))
  }
  pending.clear()
}

export function resetPermissionsPromptAdapterForTest(): void {
  pending.clear()
}

export function permissionPromptsPending(): number {
  return pending.size
}
