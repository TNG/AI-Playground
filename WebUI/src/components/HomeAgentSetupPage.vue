<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">Home Agent Setup</h1>
    <p class="text-center text-sm text-muted-foreground">
      {{ i18n.HOME_AGENT_ONLY_WHILE_OPEN }}
    </p>

    <p
      v-if="!channelStore.masterEnabled && anyEnabled"
      class="text-center text-xs text-amber-500 pt-2"
    >
      The Home Agent master switch is off — enabled channels won't run until you turn it on from the
      title bar.
    </p>

    <div class="flex gap-6 pt-6">
      <div class="w-56 shrink-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Chat Software
        </h2>
        <div class="flex flex-col gap-2">
          <SetupSidebarTile
            v-for="descriptor in CHANNELS"
            :key="descriptor.kind"
            :selected="activeTab === descriptor.kind"
            @select="activeTab = descriptor.kind"
          >
            <div class="flex items-center gap-2.5">
              <div
                class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0"
                :class="
                  channelStore.channelPrefs[descriptor.kind].verified
                    ? 'border-primary bg-primary'
                    : 'border-muted-foreground'
                "
              >
                <svg
                  v-if="channelStore.channelPrefs[descriptor.kind].verified"
                  class="w-2.5 h-2.5 text-primary-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <component :is="descriptor.icon" />
              <span class="text-sm font-medium flex-1">{{ descriptor.displayName }}</span>
            </div>

            <div class="flex items-center justify-between pl-6">
              <span
                class="text-xs font-medium"
                :class="
                  channelStore.channelPrefs[descriptor.kind].verified
                    ? 'text-emerald-500'
                    : 'text-muted-foreground'
                "
              >
                {{
                  channelStore.channelPrefs[descriptor.kind].verified ? 'Verified' : 'Not set up'
                }}
              </span>

              <button
                type="button"
                role="switch"
                :aria-checked="channelStore.channelPrefs[descriptor.kind].enabled"
                :aria-label="`Enable ${descriptor.displayName}`"
                :disabled="!channelStore.channelPrefs[descriptor.kind].verified"
                :title="
                  channelStore.channelPrefs[descriptor.kind].verified
                    ? `Enable / disable ${descriptor.displayName}`
                    : `Verify ${descriptor.displayName} before enabling it`
                "
                class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :class="
                  channelStore.channelPrefs[descriptor.kind].enabled
                    ? 'bg-primary'
                    : 'bg-muted-foreground/40'
                "
                @click.stop="
                  channelStore.setChannelEnabled(
                    descriptor.kind,
                    !channelStore.channelPrefs[descriptor.kind].enabled,
                  )
                "
              >
                <span
                  class="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                  :class="
                    channelStore.channelPrefs[descriptor.kind].enabled
                      ? 'translate-x-3.5'
                      : 'translate-x-0.5'
                  "
                />
              </button>
            </div>
          </SetupSidebarTile>
        </div>
      </div>

      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Setup Steps
        </h2>

        <template v-for="descriptor in CHANNELS" :key="descriptor.kind">
          <div v-if="activeTab === descriptor.kind">
            <!-- Collapsed summary for an already-verified channel -->
            <div
              v-if="isCollapsed(descriptor.kind)"
              class="flex items-start justify-between gap-3 p-4 rounded-lg border border-border bg-muted/30"
            >
              <div class="flex flex-col gap-1.5 min-w-0">
                <div class="flex items-center gap-2">
                  <svg
                    class="w-4 h-4 text-emerald-500 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span class="text-sm font-medium">Connected &amp; verified</span>
                </div>
                <div
                  v-if="channelStore.channelPrefs[descriptor.kind].identity"
                  class="pl-6 flex flex-col gap-0.5 min-w-0"
                >
                  <div class="flex items-center gap-1.5 text-xs min-w-0">
                    <span class="text-muted-foreground shrink-0"
                      >{{ descriptor.identityLabel }}:</span
                    >
                    <code class="bg-muted px-1 rounded select-all truncate">{{
                      channelStore.channelPrefs[descriptor.kind].identity
                    }}</code>
                  </div>
                  <p class="text-xs text-muted-foreground/70">{{ descriptor.identityHelp }}</p>
                </div>
              </div>
              <button
                type="button"
                class="text-sm font-medium text-primary hover:underline shrink-0"
                @click="expanded[descriptor.kind] = true"
              >
                Reconfigure
              </button>
            </div>

            <!-- Full setup steps (verifying collapses back to the summary) -->
            <div v-else class="flex flex-col gap-3">
              <div
                v-if="channelStore.channelPrefs[descriptor.kind].verified"
                class="flex items-center justify-between"
              >
                <span class="text-sm font-medium">Reconfigure {{ descriptor.displayName }}</span>
                <button
                  type="button"
                  class="text-sm font-medium text-muted-foreground hover:text-foreground shrink-0"
                  @click="expanded[descriptor.kind] = false"
                >
                  Cancel
                </button>
              </div>
              <component
                :is="descriptor.setupComponent"
                @verified="expanded[descriptor.kind] = false"
              />
            </div>
          </div>
        </template>
      </div>
    </div>

    <p
      v-for="notice in answerableNotices"
      :key="notice.kind"
      class="pt-2 text-sm text-muted-foreground"
    >
      {{ channelName(notice.kind) }}: {{ notice.text }}
    </p>

    <SetupWizardFooter
      :show-back="!isEditMode"
      :primary-label="isEditMode ? 'Done' : 'Continue'"
      @back="emit('back')"
      @primary="emit('done')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useChannels } from '@/assets/js/store/channels'
import { useI18N } from '@/assets/js/store/i18n'
import { CHANNELS, getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import SetupSidebarTile from '@/components/SetupSidebarTile.vue'
import SetupWizardFooter from '@/components/SetupWizardFooter.vue'
import { answerableNotice } from '@/lib/answerRouterWording'

const emit = defineEmits<{
  back: []
  done: []
}>()

const wizard = useSetupWizard()
const channelStore = useChannels()
const i18n = useI18N().state
const isEditMode = computed(() => wizard.homeAgentSetupOrigin === 'edit')

const answerableNotices = computed(() =>
  channelStore.notificationChannels.flatMap((kind) => {
    const text = answerableNotice(kind)
    return text ? [{ kind, text }] : []
  }),
)

function channelName(kind: ChannelKind): string {
  return getDescriptor(kind)?.displayName ?? kind
}

const anyEnabled = computed(() => CHANNELS.some((c) => channelStore.channelPrefs[c.kind].enabled))

/**
 * Pick the first unverified channel as the default tab — that's the one the
 * user most likely opened the wizard to configure. If every channel is
 * verified, fall back to the registry's first entry.
 */
function pickDefaultTab(): ChannelKind {
  const first = CHANNELS.find((c) => !channelStore.channelPrefs[c.kind].verified)
  return (first ?? CHANNELS[0]).kind
}
const activeTab = ref<ChannelKind>(pickDefaultTab())

// Per-kind "Reconfigure" expansion. A verified channel renders a compact
// summary until the user explicitly chooses to reconfigure it.
const expanded = reactive<Partial<Record<ChannelKind, boolean>>>({})

function isCollapsed(kind: ChannelKind): boolean {
  return channelStore.channelPrefs[kind].verified && !expanded[kind]
}
</script>
