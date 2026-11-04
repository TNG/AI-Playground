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
    <template v-if="engine === 'chat' && ragSource" #badges>
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
    <AgentMessageParts
      v-else
      :message="message"
      :section="resultOnly ? 'result' : undefined"
      :indexes="resultOnly"
    />
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UIMessage } from 'ai'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { useTextInference } from '@/assets/js/store/textInference'
import AgentMessageParts from '@/components/AgentMessageParts.vue'
import ChatMessageParts from '@/components/ChatMessageParts.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import SessionTurnFooter from '@/components/SessionTurnFooter.vue'
import SessionTurnPrompt from '@/components/SessionTurnPrompt.vue'
import { chatAnswerFooter, messagePrompt, modelDisplayName } from '@/lib/sessionTimeline'

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
const showRagSource = ref(false)

const chatMessage = computed(() => props.message as AipgUiMessage)
const ragSource = computed(() => chatMessage.value.metadata?.ragSource)

const modelLabel = computed(() => {
  const model = chatMessage.value.metadata?.model
  return model ? modelDisplayName(model) : undefined
})
</script>
