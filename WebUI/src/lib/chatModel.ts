import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from '@/assets/js/store/textInference'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from '@/assets/js/store/cloudMode'
import { getHomeAgentAuthToken, invalidateHomeAgentAuthToken } from '@/lib/loopbackAuth'

// ── Shared chat model factory ────────────────────────────────────────────────
//
// Builds the AI SDK language model for the currently selected backend/model
// (textInference + cloudMode), including all the routing/retry behavior chat
// inference depends on: cloud loopback-proxy headers, Home Agent proxy auth,
// backend relaunch-and-retry, and inference-stream tracking. Extracted from
// the openAiCompatibleChat store so nested tool agents (see
// assets/js/agents/toolAgent.ts) run against the exact same endpoint and
// model as the parent conversation.
//
// Reads reactive store state — calling it inside a computed() tracks the
// relevant dependencies (backend, model, backend URL) as before.

export function createChatModel(): LanguageModel {
  const textInference = useTextInference()
  const cloudMode = useCloudMode()

  const base = createOpenAICompatible({
    name: 'model',
    baseURL: `${textInference.currentBackendUrl}/v1/`,
    includeUsage: true,
    // For models that support toggling thinking (Qwen3 family, gemma4), send the
    // explicit enable_thinking value so the toggle is authoritative regardless of
    // the family's template default (Qwen3 defaults on, gemma4 defaults off). Both
    // llama-server (--jinja) and OVMS (--reasoning_parser qwen3) honor this kwarg.
    transformRequestBody: (args) => {
      let body: Record<string, unknown> = args
      // The Cloud "default" model is a placeholder for providers that serve
      // a single model / accept a request without one. Omit `model` entirely
      // so the provider uses its own default instead of a bogus "default" id.
      if (textInference.backend === 'cloud' && textInference.activeModel === CLOUD_DEFAULT_MODEL) {
        body = { ...body }
        delete body.model
      }
      if (textInference.modelSupportsThinkingToggle) {
        body = {
          ...body,
          chat_template_kwargs: {
            ...(body.chat_template_kwargs as Record<string, unknown> | undefined),
            enable_thinking: textInference.thinkingEnabled,
          },
        }
      }
      return body
    },
    fetch: async (url, init) => {
      // Resolve the request against the latest backend URL each call, so a
      // retry after a relaunch picks up the (possibly new) port.
      const doFetch = async (): Promise<Response> => {
        const requestUrl = new URL(url as string)
        const currentBaseUrl = textInference.currentBackendUrl
        if (currentBaseUrl) {
          const latestBase = new URL(currentBaseUrl)
          requestUrl.hostname = latestBase.hostname
          requestUrl.port = latestBase.port
        }
        // Cloud Mode routes through the main-process loopback proxy (see
        // cloudProxy.ts): it attaches the API key and calls the provider from
        // Node, so upstream failures are logged in the Node console. We only
        // tag the request with the upstream base URL and provider id — the key
        // never leaves main.
        if (textInference.backend === 'cloud') {
          const headers = new Headers(init?.headers)
          const upstream = cloudMode.activeProviderBaseUrl
          if (upstream) headers.set('X-Cloud-Upstream', upstream)
          headers.set('X-Cloud-Provider', cloudMode.selectedProviderId)
          headers.set('X-Cloud-Auth-Style', cloudMode.activeProviderAuthStyle)
          return globalThis.fetch(requestUrl.toString(), { ...init, headers })
        }
        // When Home Agent is active, the LLM proxy lives behind the Home
        // Agent Flask service. Attach the upstream inference URL header and
        // the per-launch loopback auth token so the proxy accepts the call.
        const upstreamUrl = textInference.homeAgentUpstreamUrl
        if (upstreamUrl) {
          let token = await getHomeAgentAuthToken()
          const build = (t: string): RequestInit => {
            const headers = new Headers(init?.headers)
            headers.set('X-Upstream-Url', upstreamUrl)
            if (t) headers.set('X-AIPG-Auth', t)
            return { ...init, headers }
          }
          let response = await globalThis.fetch(requestUrl.toString(), build(token))
          if (response.status === 401) {
            invalidateHomeAgentAuthToken()
            token = await getHomeAgentAuthToken(true)
            if (token) {
              response = await globalThis.fetch(requestUrl.toString(), build(token))
            }
          }
          return response
        }
        return globalThis.fetch(requestUrl.toString(), init)
      }

      // Track one attempt as an in-flight inference stream for its whole
      // lifetime — from dispatch until the response body is fully read,
      // cancelled, or errored. Image tools wait on this (via
      // textInference.waitForInferenceIdle) before freeing the GPU, so they
      // can't stop the chat backend while a stream to it is still open
      // (which would reset the socket mid-stream => "network error").
      const runTracked = async (): Promise<Response> => {
        textInference.beginInferenceStream()
        let response: Response
        try {
          response = await doFetch()
        } catch (error) {
          textInference.endInferenceStream()
          throw error
        }
        if (!response.body) {
          textInference.endInferenceStream()
          return response
        }
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          textInference.endInferenceStream()
        }
        const reader = response.body.getReader()
        const tracked = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) {
                settle()
                controller.close()
                return
              }
              controller.enqueue(value)
            } catch (error) {
              settle()
              controller.error(error)
            }
          },
          cancel(reason) {
            settle()
            return reader.cancel(reason)
          },
        })
        return new Response(tracked, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      try {
        return await runTracked()
      } catch (error) {
        // A thrown fetch error (vs. an HTTP error status) means the request
        // never reached a live server — typically the llama-server process
        // crashed or wedged (connection refused / timeout). Don't retry a
        // user-initiated abort. Otherwise relaunch the backend once (which
        // re-probes health and relaunches a dead/hung server) and retry
        // against the refreshed port.
        if (init?.signal?.aborted) throw error
        console.warn('Inference request failed; relaunching backend and retrying once:', error)
        await textInference.ensureBackendReadiness()
        return await runTracked()
      }
    },
    // Local backends encode model paths with '---' (a '/' in the repo path
    // would break the URL). Remote providers expect their model id verbatim.
  }).chatModel(
    textInference.backend === 'cloud'
      ? (textInference.activeModel ?? '')
      : (textInference.activeModel?.split('/').join('---') ?? ''),
  )
  // Local backends parse chain-of-thought server-side (llama-server --jinja /
  // OVMS --reasoning_parser qwen3) and emit it as separate reasoning content.
  // Remote Cloud Mode providers usually don't — <think>…</think> arrives inline
  // in the text stream, so it would render as answer text. Extract it into
  // reasoning parts client-side so the UI shows it as collapsible thinking.
  if (textInference.backend !== 'cloud') return base
  return wrapLanguageModel({
    model: base,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  })
}
