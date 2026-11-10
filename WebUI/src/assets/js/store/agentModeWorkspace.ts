import { computed, ref, watch, type Ref } from 'vue'
import type { GameLibraryEntry } from '@/types/agentIpc'
import { DOCUMENT_EXTENSIONS, type DocumentEmbedding } from '@/types/rag'
import { developerMode } from './debugSettings'
import { fillTemplate } from '@/lib/fillTemplate'

type Languages = Record<string, string>

export type WorkspaceAttachment = { name: string; bytes: ArrayBuffer }

export function createWorkspaceAttachments(
  errors: { report: (error: unknown, overrides: Record<string, unknown>) => void },
  languages: Languages,
) {
  /**
   * Files the user attached for the next turn, still in memory.
   *
   * They are held rather than saved on sight because the folder they belong in
   * may not exist yet: Game Agent mints a game folder from the first prompt, so
   * attaching before sending has nowhere to write to. `importAttachments` puts
   * them in the workspace once `generate` has one.
   */
  const attachments = ref<WorkspaceAttachment[]>([])

  async function attachFiles(files: File[]): Promise<void> {
    const read = await Promise.all(
      files.map(async (file) => ({ name: file.name, bytes: await file.arrayBuffer() })),
    )
    attachments.value = [...attachments.value, ...read]
  }

  function removeAttachment(index: number): void {
    attachments.value = attachments.value.filter((_, i) => i !== index)
  }

  function clearAttachments(): void {
    attachments.value = []
  }

  /**
   * Save the pending attachments into the workspace and return the sentence that
   * tells the agent about them.
   *
   * The agent gets a path, not the bytes: it reads, references and ships
   * workspace files with the tools it already has. Paths go into the prompt as
   * `@`-prefixed workspace-relative paths, which is how a file is referenced in
   * a prompt throughout Pi.
   */
  async function importAttachments(workspaceDir: string): Promise<string> {
    if (attachments.value.length === 0) return ''
    const saved: string[] = []
    for (const attachment of attachments.value) {
      const result = await window.electronAPI.agentMode.importAttachment(
        workspaceDir,
        attachment.name,
        new Uint8Array(attachment.bytes),
      )
      // Success always carries the saved path; the old `success && path` guard
      // was written against the loose envelope and cannot narrow the union.
      if (result.success) saved.push(result.path)
      else {
        errors.report(new Error(result.error ?? `Failed to attach ${attachment.name}.`), {
          category: 'unknown',
          code: 'agent/attachment-failed',
          userMessage: fillTemplate(languages.AGENT_ATTACH_FAILED, { file: attachment.name }),
          surface: 'toast',
        })
      }
    }
    clearAttachments()
    if (saved.length === 0) return ''
    const references = saved.map((file) => (/\s/.test(file) ? `@"${file}"` : `@${file}`))
    return `\n\nAttached files, saved in the workspace: ${references.join(' ')}`
  }

  return { attachments, attachFiles, removeAttachment, clearAttachments, importAttachments }
}

const DOCUMENT_NAME = new RegExp(`\\.(${DOCUMENT_EXTENSIONS.join('|')})$`, 'i')

/** What the `rag` tool can index. */
export function isDocumentName(name: string): boolean {
  return DOCUMENT_NAME.test(name)
}

/** Documents are saved and indexed on attach, so the first question about one does not wait. */
export function createSessionDocuments(options: {
  workspaceDir: Ref<string>
  workspaceReady: () => Promise<boolean>
  /** The embedding model `rag` searches with, or null when document search is off. */
  embedding: () => DocumentEmbedding | null
  /** Resolves once the model is on disk; false when the user declined the download. */
  prepareEmbedding: (embedding: DocumentEmbedding) => Promise<boolean>
  errors: { report: (error: unknown, overrides: Record<string, unknown>) => void }
  languages: Languages
}) {
  const { workspaceDir, errors, languages } = options
  const sessionDocuments = ref<string[]>([])
  const indexingDocuments = ref<string[]>([])

  async function refreshSessionDocuments(): Promise<void> {
    const dir = workspaceDir.value
    const documents = dir ? await window.electronAPI.agentMode.sessionDocuments(dir) : []
    if (workspaceDir.value === dir) sessionDocuments.value = documents
  }
  watch(workspaceDir, () => void refreshSessionDocuments(), { immediate: true })

  async function saveDocuments(dir: string, files: File[]): Promise<string[]> {
    const saved: string[] = []
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await window.electronAPI.agentMode.importAttachment(dir, file.name, bytes)
      if (result.success) saved.push(result.path)
      else {
        errors.report(new Error(result.error ?? `Failed to attach ${file.name}.`), {
          category: 'unknown',
          code: 'agent/attachment-failed',
          userMessage: fillTemplate(languages.AGENT_ATTACH_FAILED, { file: file.name }),
          surface: 'toast',
        })
      }
    }
    return saved
  }

  async function indexDocuments(dir: string, paths: string[]): Promise<void> {
    const embedding = options.embedding()
    if (!embedding || paths.length === 0) return
    if (!(await options.prepareEmbedding(embedding))) return
    indexingDocuments.value = [...indexingDocuments.value, ...paths]
    try {
      for (const file of paths) {
        const result = await window.electronAPI.agentMode.indexDocument(dir, file, embedding)
        if (!result.success) {
          // The `rag` tool indexes it again on the first question, so this is not fatal.
          errors.report(new Error(result.error ?? `Failed to index ${file}.`), {
            category: 'inference',
            code: 'agent/document-index-failed',
            severity: 'warn',
            surface: 'silent',
          })
        }
      }
    } finally {
      indexingDocuments.value = indexingDocuments.value.filter((file) => !paths.includes(file))
    }
  }

  async function attachDocuments(files: File[]): Promise<void> {
    if (!workspaceDir.value && !(await options.workspaceReady())) return
    const dir = workspaceDir.value
    const saved = await saveDocuments(dir, files)
    await refreshSessionDocuments()
    await indexDocuments(dir, saved)
  }

  async function removeDocument(file: string): Promise<void> {
    const dir = workspaceDir.value
    if (!dir) return
    const result = await window.electronAPI.agentMode.removeSessionDocument(dir, file)
    if (!result.success) {
      errors.report(new Error(result.error ?? `Failed to remove ${file}.`), {
        category: 'unknown',
        code: 'agent/document-remove-failed',
        userMessage: fillTemplate(languages.AGENT_DOCUMENT_REMOVE_FAILED, {
          file: file.split('/').pop() ?? file,
        }),
        surface: 'toast',
      })
    }
    await refreshSessionDocuments()
  }

  return {
    sessionDocuments,
    indexingDocuments,
    attachDocuments,
    removeDocument,
    refreshSessionDocuments,
  }
}

export async function isGameFolder(dir: string): Promise<boolean> {
  return !!dir && !!(await window.electronAPI.games.read(dir))
}

export function createUnsandboxedWorkspaces(workspaceDir: Ref<string>) {
  const unsandboxedWorkspaces = ref<string[]>([])
  // The opt-ins survive leaving developer mode, but only count inside it.
  function isUnsandboxed(folder: string): boolean {
    return !!folder && developerMode() && unsandboxedWorkspaces.value.includes(folder)
  }
  const unsandboxed = computed(() => isUnsandboxed(workspaceDir.value))

  function setUnsandboxed(enabled: boolean): void {
    const folder = workspaceDir.value
    if (!folder) return
    const others = unsandboxedWorkspaces.value.filter((entry) => entry !== folder)
    unsandboxedWorkspaces.value = enabled ? [...others, folder] : others
  }

  return { unsandboxedWorkspaces, unsandboxed, isUnsandboxed, setUnsandboxed }
}

/** A games preset holding a folder that is not a game goes back to its last game. */
export async function reconcileGamesWorkspace(options: {
  kind: 'pick' | 'games'
  workspaceDir: string
  lastGamesDir: string
}): Promise<{ workspaceDir: string } | null> {
  if (options.kind !== 'games') return null
  if (!options.workspaceDir) return null
  if (await isGameFolder(options.workspaceDir)) return null
  return { workspaceDir: options.lastGamesDir ?? '' }
}

export type { GameLibraryEntry }
