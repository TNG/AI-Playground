<template>
  <div
    v-if="messages.length > 0"
    role="list"
    :aria-label="languages.SESSION_CHANNEL_QUEUED_LIST"
    class="flex flex-col gap-3 opacity-70"
  >
    <div v-for="message in messages" :key="message.id" role="listitem">
      <SessionUserBubble>
        <p class="whitespace-pre-wrap">{{ message.text }}</p>
        <template #aside>
          <span
            class="self-center inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            <ClockIcon class="size-3.5" aria-hidden="true" />
            {{
              fillTemplate(languages.SESSION_CHANNEL_QUEUED, {
                channel: CHANNEL_NAMES[message.channel],
              })
            }}
          </span>
        </template>
      </SessionUserBubble>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ClockIcon } from '@heroicons/vue/24/outline'
import { useChannelQueue } from '@/assets/js/store/channelQueue'
import { useI18N } from '@/assets/js/store/i18n'
import SessionUserBubble from '@/components/SessionUserBubble.vue'
import { CHANNEL_NAMES } from '@/lib/channelNames'
import { fillTemplate } from '@/lib/fillTemplate'

/** Channel messages waiting for the Session's turn or Agent Run to end, oldest first. */
const props = defineProps<{ sessionRef: string | null }>()

const channelQueue = useChannelQueue()
const languages = useI18N().state

const messages = computed(() => channelQueue.queuedIn(props.sessionRef))
</script>
