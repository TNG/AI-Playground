<template>
  <div class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative" ref="panel">
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-4 pt-20">
      <!-- Configuration bar -->
      <div class="rounded-md border border-border bg-muted/20 p-4 flex flex-col gap-3">
        <div class="flex items-center gap-3 flex-wrap">
          <Button variant="secondary" @click="agentMode.pickWorkspaceFolder()">
            Select folder…
          </Button>
          <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
            {{ agentMode.workspaceDir }}
          </span>
          <span v-else class="text-sm text-muted-foreground italic">
            No workspace folder selected
          </span>
          <div class="flex-1"></div>
          <Button variant="secondary" @click="agentMode.resetSession()">Reset session</Button>
        </div>
        <div class="flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
          <span v-if="agentMode.modelSource === 'local'">
            Local model: {{ textInference.activeModel ?? 'none selected' }} ({{
              textInference.backend
            }}, {{ textInference.contextSize }} ctx)
          </span>
          <span v-else>
            Cloud model: {{ agentMode.cloudModel || 'Pi default' }} ({{ agentMode.cloudProvider }})
          </span>
          <span class="text-xs">— change via Agent Settings below</span>
        </div>
        <p class="text-xs text-amber-500">
          The agent runs with all file/shell permissions inside the selected folder (and its parent
          directory) — proof of concept, use a scratch folder.
        </p>
      </div>

      <!-- Messages -->
      <!-- eslint-disable vue/require-v-for-key -->
      <template v-for="message in agentMode.messages">
        <!-- eslint-enable -->
        <div v-if="message.role === 'user'" class="flex items-start gap-3">
          <UserCircleIcon class="size-6 text-foreground/90" />
          <div class="flex flex-col gap-2 max-w-4/5 bg-muted rounded-md px-4 py-3">
            <MarkdownRenderer :content="messageText(message)" />
          </div>
        </div>
        <div v-else-if="message.role === 'assistant'" class="flex items-start gap-3">
          <img src="../assets/svg/ai-icon.svg" class="size-6" />
          <div class="flex flex-col gap-3 w-full max-w-4/5">
            <template v-for="(part, partIndex) in message.parts" :key="partIndex">
              <MarkdownRenderer v-if="part.type === 'text'" :content="part.text ?? ''" />
              <ChatReasoningDisplay
                v-else-if="part.type === 'reasoning'"
                :text="part.text"
                :streaming="false"
              />
              <ChatToolDisplay
                v-else-if="isToolUIPart(part as UIMessagePart<UIDataTypes, UITools>)"
                :part="asToolPart(part)"
                :state="asToolPart(part).state"
              />
            </template>
          </div>
        </div>
      </template>

      <div
        v-if="agentMode.processing"
        class="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <span class="animate-pulse">Agent is working…</span>
      </div>
      <div
        v-if="agentMode.chat.error"
        class="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ agentMode.chat.error.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isToolUIPart, type UIDataTypes, type UIMessagePart, type UITools } from 'ai'
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useTextInference } from '@/assets/js/store/textInference'
import { usePromptStore } from '@/assets/js/store/promptArea'
import type { AipgTools } from '@/assets/js/tools/tools'
import { Button } from '@/components/ui/button'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import { UserCircleIcon } from '@heroicons/vue/24/outline'

const agentMode = useAgentMode()
const textInference = useTextInference()
const promptStore = usePromptStore()

const panel = ref<HTMLElement | null>(null)

function messageText(message: UIMessage): string {
  return (
    message.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n') ?? ''
  )
}

// Pi's tool parts (tool-bash, tool-read, …) are not part of AipgTools, but the
// generic ChatToolDisplay only reads name/state/input/output — cast for reuse.
function asToolPart(part: unknown): ToolUIPart<AipgTools> | DynamicToolUIPart {
  return part as ToolUIPart<AipgTools> | DynamicToolUIPart
}

function handlePromptSubmit(prompt: string) {
  void agentMode.generate(prompt)
}

function handleCancel() {
  void agentMode.stop()
}

watch(
  () => agentMode.messages.length + (agentMode.messages.at(-1)?.parts?.length ?? 0),
  async () => {
    await nextTick()
    panel.value?.scrollTo({ top: panel.value.scrollHeight })
  },
)

onMounted(() => {
  promptStore.registerSubmitCallback('agent', handlePromptSubmit)
  promptStore.registerCancelCallback('agent', handleCancel)
})

onUnmounted(() => {
  promptStore.unregisterSubmitCallback('agent')
  promptStore.unregisterCancelCallback('agent')
})
</script>
