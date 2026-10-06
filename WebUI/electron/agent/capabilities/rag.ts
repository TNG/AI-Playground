import path from 'node:path'
import fs from 'node:fs'
import type { Document } from '@langchain/classic/document'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { EmbedInquiry, IndexedDocument } from '@/assets/js/store/textInference.ts'
import { RAG_PREPARE_EMBEDDING_MODEL } from '@/types/agentCapabilities'
import {
  executeToolInRenderer,
  jsonSchemaParameters,
  textResult,
  type SkillSource,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import { ragAccess } from '../ragAccess.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

// ── rag capability ───────────────────────────────────────────────────────────
//
// Semantic search over one large document in the workspace: split + embed the
// file on first use (langchain worker), then return the k best-matching
// passages as the tool result. The agent's alternative — `read` — pulls the
// whole file into context, which is exactly what this avoids. Chunks are never
// injected into the system prompt (that is the chat pipeline's shape) and the
// index is session-scoped: it lives in the buildTools closure, so it dies with
// the session and a fresh session re-pays only the split — chunk embeddings are
// disk-cached by the langchain worker, namespaced per embedding model.

const RAG_TOOL_DESCRIPTION =
  'Semantic search over one or more large documents in the workspace (pdf, docx, doc, md, txt). ' +
  "Pass a list of file paths and a question; it returns the k best-matching passages across the merged documents, each labelled with its source file and page or line numbers. Use it to answer questions about documents too large to read into context in full. Prefer 'read' for small files. " +
  'The first call on a file indexes it and can take a while; later calls are fast.'

// Mirrors piToolOperations.SANDBOX_WORKDIR — the path Pi's sandbox mounts the
// workspace at, so the model (which lives there) addresses files as
// /workspace/<name>. Defined here rather than imported so the capability module
// stays free of the Electron/service imports piToolOperations pulls in.
const SANDBOX_WORKDIR = '/workspace'

const RAG_SKILL: SkillSource = {
  name: 'document-search',
  description:
    'Find answers inside large workspace documents (PDF, Word, Markdown, text) with the `rag` tool instead of reading them whole.',
  body: [
    '`read` loads a whole file into context — fine for code, wrong for a 300-page PDF.',
    'For questions about big documents, call `rag` with a list of file paths',
    '(workspace-relative like "report.pdf", or the "/workspace/report.pdf" form',
    'other tools show) and the question; it returns the best-matching passages,',
    'each labelled with the file it came from.',
    '',
    '- Pass multiple files to search across them at once; the top-k passages are',
    '  ranked over the merged document set.',
    '- The first call on a file indexes it (slow on big PDFs); later calls return fast.',
    '  Do not re-call with the same query to "check" the result.',
    '- Raise `k` (default 5, max 20) when you need broader coverage of the documents.',
    '- Passages carry page numbers for PDFs and line ranges for text — cite them.',
    '- Unsupported file types (code, images, …) are not indexable; use `read` instead.',
    '- Invalid files are skipped with a note; the rest are still searched.',
  ].join('\n'),
}

const RAG_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    files: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Paths of the documents to search — workspace-relative ("report.pdf") or the /workspace/report.pdf form other tools show. Pass one or more; they are searched as a merged set.',
    },
    query: {
      type: 'string',
      description: 'The question or topic to find passages about.',
    },
    k: {
      type: 'integer',
      description: 'How many passages to return across all documents (default 5, max 20).',
    },
  },
  required: ['files', 'query'],
}

/** Exactly what the langchain worker's loadDocument can index. */
const SUPPORTED_EXTENSIONS = ['txt', 'md', 'doc', 'docx', 'pdf'] as const

const DEFAULT_K = 5
const MAX_K = 20
/** Chunks are model context; a runaway k must not eat the window. */
const MAX_RESULT_CHARS = 20_000

type RagToolParams = {
  files?: unknown
  query?: unknown
  k?: unknown
}

type IndexedCacheEntry = {
  mtimeMs: number
  doc: IndexedDocument
}

/**
 * Resolve a model-provided path against the (realpathed) workspace dir.
 *
 * The agent lives in Pi's sandbox, where the workspace is mounted at
 * /workspace: bash's cwd is /workspace and every built-in tool (read, ls, find)
 * reports /workspace/<name> paths. `ls`/`find`/`grep` return relative names, but
 * the model usually reconstructs the absolute form on a first attempt, so
 * accept that prefix and treat the rest as workspace-relative. In host-shell
 * mode the same happens with the real workspace dir. Either way the unchanged
 * realpath containment check below is the sole authority for what is inside:
 * symlinks pointing out, `..` traversals and absolute outside paths all stay
 * rejected. Returns null when the path is not a workspace file.
 */
function resolveWorkspaceFile(workspaceDir: string, inputPath: string): string | null {
  if (!inputPath) return null
  let candidate = inputPath
  if (candidate.startsWith(SANDBOX_WORKDIR + '/')) {
    candidate = candidate.slice(SANDBOX_WORKDIR.length + 1)
  }
  let root: string
  try {
    root = fs.realpathSync(workspaceDir)
  } catch {
    return null
  }
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    return null
  }
  const relative = path.relative(root, real)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return real
}

function chunkLocation(metadata: Document['metadata']): string | undefined {
  const loc = (metadata as Record<string, unknown> | undefined)?.loc as
    Record<string, unknown> | undefined
  const page = typeof loc?.pageNumber === 'number' ? `page ${loc.pageNumber}` : undefined
  const lines = loc?.lines as { from?: number; to?: number } | undefined
  const lineRange =
    lines && typeof lines.from === 'number'
      ? `lines ${lines.from}-${typeof lines.to === 'number' ? lines.to : lines.from}`
      : undefined
  const where = [page, lineRange].filter(Boolean).join(', ')
  return where || undefined
}

function userFileLabel(input: string): string {
  if (input.startsWith(SANDBOX_WORKDIR + '/')) return input.slice(SANDBOX_WORKDIR.length + 1)
  return input
}

function coerceFileList(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : []
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((s) => s.length > 0)
}

function formatChunks(
  chunks: Document[],
  labelForSource: Map<string, string>,
  k: number,
  documentCount: number,
): string {
  const blocks: string[] = []
  let used = 0
  let shown = 0
  for (const chunk of chunks) {
    const content = chunk.pageContent.trim()
    if (!content) continue
    if (used > 0 && used + content.length > MAX_RESULT_CHARS) break
    used += content.length
    shown += 1
    const where = chunkLocation(chunk.metadata)
    const source = (chunk.metadata as Record<string, unknown> | undefined)?.source
    const fileLabel =
      typeof source === 'string' ? (labelForSource.get(source) ?? path.basename(source)) : undefined
    let detail: string
    if (fileLabel && where) detail = ` — ${fileLabel} (${where})`
    else if (fileLabel) detail = ` — ${fileLabel}`
    else if (where) detail = ` (${where})`
    else detail = ''
    const header = `── passage ${shown}${detail} ──`
    blocks.push(`${header}\n${content}`)
  }
  const truncated =
    shown < chunks.length ? '\n\n(more passages matched but were left out to fit the context)' : ''
  const docWord = documentCount === 1 ? 'document' : 'documents'
  return `${shown} passage(s) from ${documentCount} ${docWord} (k=${k}):\n\n${blocks.join('\n\n')}${truncated}`
}

async function buildRagTool(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  const { workspaceDir } = host

  // Session-scoped: built once per session, dies with its tools.
  const indexedFiles = new Map<string, IndexedCacheEntry>()
  const ensuredServers = new Map<string, string>()
  const preparedDownloads = new Set<string>()

  return [
    pi.defineTool({
      name: 'rag',
      label: 'rag',
      description: RAG_TOOL_DESCRIPTION,
      parameters: jsonSchemaParameters(RAG_INPUT_SCHEMA),
      execute: async (toolCallId, params, signal) => {
        const { files, query, k: rawK } = (params ?? {}) as RagToolParams
        const question = typeof query === 'string' ? query.trim() : ''
        const parsedK = Math.trunc(Number(rawK ?? DEFAULT_K))
        const k = Math.min(MAX_K, Math.max(1, Number.isNaN(parsedK) ? DEFAULT_K : parsedK))
        const embeddingModel = host.embeddingModel
        const embeddingBackend = host.embeddingBackend ?? 'llamaCPP'

        const fileList = coerceFileList(files)
        if (fileList.length === 0 || !question) {
          return textResult('Provide a non-empty "files" list and a "query".')
        }
        if (!embeddingModel) {
          return textResult(
            'No embedding model is configured for this session, so documents cannot be indexed. ' +
              'Answer from what you can read directly.',
          )
        }

        // Resolve + validate every file before prompting for the embedding model,
        // so a batch of invalid paths never triggers a download dialog.
        const skipped: string[] = []
        const valid: { input: string; realPath: string; extension: string; mtimeMs: number }[] = []
        for (const input of fileList) {
          const realPath = resolveWorkspaceFile(workspaceDir, input)
          if (!realPath) {
            skipped.push(`"${input}" — not a file in the workspace folder`)
            continue
          }
          const extension = path.extname(realPath).slice(1).toLowerCase()
          if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
            skipped.push(`"${input}" — not an indexable document (pdf, docx, doc, md, txt)`)
            continue
          }
          let mtimeMs = 0
          try {
            mtimeMs = fs.statSync(realPath).mtimeMs
          } catch {
            skipped.push(`"${input}" — could not read the file`)
            continue
          }
          valid.push({ input, realPath, extension, mtimeMs })
        }

        if (valid.length === 0) {
          return textResult(
            `No documents could be searched. Skipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}\n\nRead the files with 'read' instead.`,
          )
        }

        const serverKey = `${embeddingBackend}/${embeddingModel}`
        if (!preparedDownloads.has(serverKey)) {
          // The renderer owns the download policy (shared dialog), so a
          // missing embedding model is prompted for on first actual use —
          // the same UX as chat and media. Once per session.
          const prep = (await executeToolInRenderer(
            RAG_PREPARE_EMBEDDING_MODEL,
            { model: embeddingModel, backend: embeddingBackend },
            toolCallId,
            signal ?? undefined,
          )) as { status?: unknown } | null
          if (prep?.status !== 'ready') {
            return textResult(
              'The user declined the embedding model download, so documents cannot be indexed. ' +
                "Read the documents with 'read' instead.",
            )
          }
          preparedDownloads.add(serverKey)
        }

        const ragList: IndexedDocument[] = []
        const labelForSource = new Map<string, string>()
        for (const { input, realPath, extension, mtimeMs } of valid) {
          const cached = indexedFiles.get(realPath)
          if (!cached || cached.mtimeMs !== mtimeMs) {
            try {
              const stub: IndexedDocument = {
                filename: path.basename(realPath),
                filepath: realPath,
                type: extension as IndexedDocument['type'],
                splitDB: [],
                hash: '',
                isChecked: true,
              }
              const doc = await ragAccess().ingest(stub)
              indexedFiles.set(realPath, { mtimeMs, doc })
            } catch (error) {
              skipped.push(
                `"${input}" — ingest failed: ${error instanceof Error ? error.message : String(error)}`,
              )
              continue
            }
          }

          const indexed = indexedFiles.get(realPath) as IndexedCacheEntry
          if (!indexed.doc.splitDB || indexed.doc.splitDB.length === 0) {
            skipped.push(`"${input}" — no indexable text content`)
            continue
          }
          ragList.push({ ...indexed.doc, isChecked: true })
          labelForSource.set(realPath, userFileLabel(input))
        }

        if (ragList.length === 0) {
          return textResult(
            `No documents could be indexed for this query. Skipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}`,
          )
        }

        try {
          let baseUrl = ensuredServers.get(serverKey)
          if (!baseUrl) {
            try {
              baseUrl = await ragAccess().ensureEmbeddingServer(embeddingBackend, embeddingModel)
            } catch (error) {
              return textResult(
                `The embedding model "${embeddingModel}" is not usable on this machine ` +
                  `(${error instanceof Error ? error.message : String(error)}). ` +
                  "Download it in Settings, or read the documents with 'read' instead.",
              )
            }
            ensuredServers.set(serverKey, baseUrl)
          }

          const inquiry: EmbedInquiry = {
            prompt: question,
            ragList,
            backendBaseUrl: baseUrl,
            embeddingModel,
            maxResults: k,
            useGroupRetrieval: false,
          }
          const chunks = await ragAccess().retrieve(inquiry)
          if (chunks.length === 0) {
            const tail =
              skipped.length > 0 ? `\n\nSkipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}` : ''
            return textResult(`No passage matched the query.${tail}`)
          }
          const body = formatChunks(chunks, labelForSource, k, ragList.length)
          const tail =
            skipped.length > 0 ? `\n\nSkipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}` : ''
          return textResult(`${body}${tail}`)
        } catch (error) {
          return textResult(
            `Document search failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      },
    }) as ToolDefinition,
  ]
}

export const ragCapability: AgentCapability = {
  id: 'rag',
  label: 'Document search',
  summary:
    'Answer questions about large workspace documents (PDF, Word, Markdown, text) by searching them semantically instead of reading them whole. Pass one or more files to search across them as a merged set.',
  skills: [RAG_SKILL],
  buildTools: buildRagTool,
  unavailableReason: (host) =>
    host.embeddingModel
      ? undefined
      : 'No embedding model selected — pick one in Agent Settings to enable it.',
  lazyEligible: true,
}

export const testables = {
  DEFAULT_K,
  MAX_K,
  MAX_RESULT_CHARS,
  SUPPORTED_EXTENSIONS,
  resolveWorkspaceFile,
  coerceFileList,
  userFileLabel,
  formatChunks,
  chunkLocation,
}
