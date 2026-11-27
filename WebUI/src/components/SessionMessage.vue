<template>
  <SessionTurnPrompt
    v-if="message.role === 'user'"
    :prompt="messagePrompt(message)"
    :queued="queued"
    :not-run="notRun"
    :can-resend="canResend"
    @resend="emit('resend')"
  />
  <SessionAssistantBubble
    v-else-if="message.role === 'assistant'"
    :label="unlabelled ? undefined : modelLabel"
  >
    <template v-if="ragSource" #badges>
      <button
        class="bg-primary text-foreground font-sans rounded-md px-1 py-1 flex items-center gap-1"
        :class="textInference.nameSizeClass"
        :aria-expanded="showRagSource"
        @click="showRagSource = !showRagSource"
      >
        Source Docs
        <img v-if="showRagSource" src="../assets/svg/arrow-up.svg" class="w-3 h-3" alt="" />
        <img v-else src="../assets/svg/arrow-down.svg" class="w-3 h-3" alt="" />
      </button>
    </template>
    <template v-if="engine === 'chat'">
      <ChatMessageParts
        :message="chatMessage"
        :last="last"
        :conversation-key="conversationKey ?? ''"
        :show-rag-source="showRagSource"
        :section="resultOnly ? 'result' : undefined"
        :indexes="resultOnly"
      />
      <SessionTurnFooter v-if="!footerless" :footer="chatAnswerFooter([message], last)" />
    </template>
    <template v-else>
      <div
        v-if="showRagSource && ragSource"
        class="my-2 text-muted-foreground border-l-2 border-primary pl-2 flex flex-row gap-1"
        :class="textInference.fontSizeClass"
      >
        <div class="font-bold">{{ languages.RAG_SOURCE }}:</div>
        <div class="whitespace-pre-wrap">{{ ragSource }}</div>
      </div>
      <AgentMessageParts
        :message="message"
        :section="resultOnly ? 'result' : undefined"
        :indexes="resultOnly"
      />
    </template>
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UIMessage } from 'ai'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'
import AgentMessageParts from '@/components/AgentMessageParts.vue'
import ChatMessageParts from '@/components/ChatMessageParts.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import SessionTurnFooter from '@/components/SessionTurnFooter.vue'
import SessionTurnPrompt from '@/components/SessionTurnPrompt.vue'
import { agentRagSource } from '@/lib/ragSources'
import { messagePrompt } from '@/lib/sessionTimeline'
import { chatAnswerFooter } from '@/lib/turnFooter'
import { modelDisplayName } from '@/lib/turnText'

/**
 * One message of a Session, chat or agent, live or settled: the same bubbles
 * everywhere, with the answer's body drawn by the engine that produced it.
 */
const props = defineProps<{
  message: UIMessage
  engine: 'chat' | 'agent'
  /** Chat: the newest message of the live conversation. */
  last?: boolean
  /** Chat: the conversation the message belongs to, for its live status. */
  conversationKey?: string
  queued?: boolean
  notRun?: boolean
  canResend?: boolean
  /** The Turn's hint already names the model, so the answer does not. */
  unlabelled?: boolean
  /** In a Turn: the parts of this answer that belong to its Result; the rest is in Turn Details. */
  resultOnly?: readonly number[]
  /** The Turn's footer carries the answer's actions. */
  footerless?: boolean
}>()

const emit = defineEmits<{ resend: [] }>()

const textInference = useTextInference()
const languages = useI18N().state
const showRagSource = ref(false)

const chatMessage = computed(() => props.message as AipgUiMessage)
const ragSource = computed(() =>
  props.engine === 'chat' ? chatMessage.value.metadata?.ragSource : agentRagSource(props.message),
)

const modelLabel = computed(() => {
  const model = chatMessage.value.metadata?.model
  return model ? modelDisplayName(model) : undefined
})
</script>
