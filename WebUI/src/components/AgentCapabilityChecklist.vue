<template>
  <div class="flex flex-col gap-2">
    <template v-for="capability in builtInCapabilities" :key="capability.id">
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!!capability.unavailableReason"
          :checked="isEnabled(capability.id)"
          :aria-describedby="showNotifyHint(capability.id) ? 'agent-notify-hint' : undefined"
          @change="toggle(capability.id, $event)"
        />
        <span class="flex flex-col">
          <span class="text-foreground">{{ capability.label }}</span>
          <span class="text-xs text-muted-foreground">{{ capability.summary }}</span>
          <span v-if="capability.requires.length > 0" class="text-xs text-muted-foreground">
            Also enables: {{ capabilityLabels(capability.requires) }}
          </span>
          <span
            v-if="showNotifyHint(capability.id)"
            id="agent-notify-hint"
            class="text-xs text-amber-500"
          >
            {{ i18n.AGENT_NOTIFY_NEEDS_HOME_AGENT }}
          </span>
          <span v-if="capability.unavailableReason" class="text-xs text-amber-500">
            {{ capability.unavailableReason }}
          </span>
        </span>
      </label>
      <slot name="after" :id="capability.id" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { toggleCapabilityIds } from '@/assets/js/store/agentModeSessions'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useI18N } from '@/assets/js/store/i18n'
import { MCP_CAPABILITY_PREFIX, NOTIFY_CAPABILITY_ID } from '@/types/agentCapabilities'

const props = defineProps<{
  catalog: AgentCapabilityInfo[]
}>()

const capabilities = defineModel<string[]>({ required: true })

const homeAgent = useHomeAgent()
const i18n = useI18N().state

function showNotifyHint(id: string): boolean {
  return id === NOTIFY_CAPABILITY_ID && !homeAgent.notificationsReady
}

const builtInCapabilities = computed(() =>
  props.catalog.filter((capability) => !capability.id.startsWith(MCP_CAPABILITY_PREFIX)),
)

function isEnabled(id: string): boolean {
  return capabilities.value.includes(id)
}

function toggle(id: string, event: Event): void {
  capabilities.value = toggleCapabilityIds(
    capabilities.value,
    id,
    (event.target as HTMLInputElement).checked,
  )
}

function capabilityLabels(ids: string[]): string {
  return ids.map((id) => props.catalog.find((entry) => entry.id === id)?.label ?? id).join(', ')
}
</script>
