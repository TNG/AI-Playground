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
  'Semantic search over one large document in the workspace (pdf, docx, doc, md, txt). ' +
  "Use it to answer questions about a document too large to read into context in full; returns the k best-matching passages with page or line numbers. Prefer 'read' for small files. " +
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
    'For questions about a big document, call `rag` with the file path',
    '(workspace-relative like "report.pdf", or the "/workspace/report.pdf" form',
    'other tools show) and the question; it returns the best-matching passages',
    '',
    '- The first call on a file indexes it (slow on big PDFs); later calls return fast.',
    '  Do not re-call with the same query to "check" the result.',
    '- Raise `k` (default 5, max 20) when you need broader coverage of the document.',
    '- Passages carry page numbers for PDFs and line ranges for text — cite them.',
    '- Unsupported file types (code, images, …) are not indexable; use `read` instead.',
  ].join('\n'),
}

const RAG_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: {
      type: 'string',
      description:
        'Path of the document to search — workspace-relative ("report.pdf") or the /workspace/report.pdf form other tools show.',
    },
    query: {
      type: 'string',
      description: 'The question or topic to find passages about.',
    },
    k: {
      type: 'integer',
      description: 'How many passages to return (default 5, max 20).',
    },
  },
  required: ['file', 'query'],
}

/** Exactly what the langchain worker's loadDocument can index. */
const SUPPORTED_EXTENSIONS = ['txt', 'md', 'doc', 'docx', 'pdf'] as const

const DEFAULT_K = 5
const MAX_K = 20
/** Chunks are model context; a runaway k must not eat the window. */
const MAX_RESULT_CHARS = 20_000

type RagToolParams = {
  file?: unknown
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

function formatChunks(chunks: Document[], fileLabel: string, k: number): string {
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
    const header = `── passage ${shown}${where ? ` (${where})` : ''} ──`
    blocks.push(`${header}\n${content}`)
  }
  const truncated =
    shown < chunks.length ? '\n\n(more passages matched but were left out to fit the context)' : ''
  return `${shown} passage(s) from ${fileLabel} (k=${k}):\n\n${blocks.join('\n\n')}${truncated}`
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
        const { file, query, k: rawK } = (params ?? {}) as RagToolParams
        const filePath = typeof file === 'string' ? file.trim() : ''
        const question = typeof query === 'string' ? query.trim() : ''
        const parsedK = Math.trunc(Number(rawK ?? DEFAULT_K))
        const k = Math.min(MAX_K, Math.max(1, Number.isNaN(parsedK) ? DEFAULT_K : parsedK))
        const embeddingModel = host.embeddingModel
        const embeddingBackend = host.embeddingBackend ?? 'llamaCPP'

        if (!filePath || !question) {
          return textResult('Provide both a "file" path and a "query".')
        }
        if (!embeddingModel) {
          return textResult(
            'No embedding model is configured for this session, so documents cannot be indexed. ' +
              'Answer from what you can read directly.',
          )
        }

        const realPath = resolveWorkspaceFile(workspaceDir, filePath)
        if (!realPath) {
          return textResult(
            `Not a file in the workspace folder: "${filePath}". Pass a workspace path, e.g. "report.pdf" or "/workspace/report.pdf".`,
          )
        }
        const extension = path.extname(realPath).slice(1).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number])) {
          return textResult(
            `"${filePath}" is not an indexable document (pdf, docx, doc, md, txt). ` +
              "Read it with 'read' instead.",
          )
        }

        try {
          let mtimeMs = 0
          try {
            mtimeMs = fs.statSync(realPath).mtimeMs
          } catch {
            return textResult(`Could not read the file: "${filePath}".`)
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
                  "Read the document with 'read' instead.",
              )
            }
            preparedDownloads.add(serverKey)
          }

          const cached = indexedFiles.get(realPath)
          if (!cached || cached.mtimeMs !== mtimeMs) {
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
          }

          let baseUrl = ensuredServers.get(serverKey)
          if (!baseUrl) {
            try {
              baseUrl = await ragAccess().ensureEmbeddingServer(embeddingBackend, embeddingModel)
            } catch (error) {
              return textResult(
                `The embedding model "${embeddingModel}" is not usable on this machine ` +
                  `(${error instanceof Error ? error.message : String(error)}). ` +
                  "Download it in Settings, or read the document with 'read' instead.",
              )
            }
            ensuredServers.set(serverKey, baseUrl)
          }

          const indexed = (indexedFiles.get(realPath) as IndexedCacheEntry).doc
          if (!indexed.splitDB || indexed.splitDB.length === 0) {
            return textResult(
              `"${filePath}" has no indexable text content (it may be empty or scanned images).`,
            )
          }

          const inquiry: EmbedInquiry = {
            prompt: question,
            ragList: [{ ...indexed, isChecked: true }],
            backendBaseUrl: baseUrl,
            embeddingModel,
            maxResults: k,
            useGroupRetrieval: false,
          }
          const chunks = await ragAccess().retrieve(inquiry)
          if (chunks.length === 0) {
            return textResult(
              `No passage in "${filePath}" matched the query. Rephrase the question, or read the file directly.`,
            )
          }
          return textResult(formatChunks(chunks, filePath, k))
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
    'Answer questions about large workspace documents (PDF, Word, Markdown, text) by searching them semantically instead of reading them whole.',
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
  formatChunks,
  chunkLocation,
}
