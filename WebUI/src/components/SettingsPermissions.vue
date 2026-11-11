<template>
  <DemoModeBlocker>
    <div class="flex flex-col gap-3 pt-4">
      <SettingsHeading>{{ languages.SETTINGS_PERMISSIONS }}</SettingsHeading>
      <div class="pl-2 pt-2 flex flex-col gap-4">
        <div class="flex justify-between pr-4 items-start gap-4">
          <div class="flex flex-col gap-1 min-w-0">
            <Label
              for="remote-download-pregrant"
              :class="{ 'opacity-50': !channelStore.hasConfiguredChannel }"
              >{{ languages.SETTINGS_PERMISSIONS_REMOTE_DOWNLOADS }}</Label
            >
            <p class="text-xs text-muted-foreground">
              {{ languages.SETTINGS_PERMISSIONS_REMOTE_DOWNLOADS_INFO }}
            </p>
            <p
              v-if="!channelStore.hasConfiguredChannel"
              class="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2"
            >
              {{ languages.SETTINGS_PERMISSIONS_REMOTE_DOWNLOADS_NO_CHANNEL }}
              <button
                type="button"
                class="text-primary underline-offset-2 hover:underline"
                @click="setupWizard.openHomeAgentSetup()"
              >
                {{ languages.SETTINGS_PERMISSIONS_SETUP_HOME_AGENT }}
              </button>
            </p>
          </div>
          <Checkbox
            id="remote-download-pregrant"
            class="mt-0.5"
            :disabled="!channelStore.hasConfiguredChannel && !remoteDownloadsGranted"
            :model-value="remoteDownloadsGranted"
            @update:model-value="(v) => setRemoteDownloads(v === true)"
          />
        </div>

        <div class="border-t border-border pt-3 flex flex-col gap-2 pr-4">
          <p v-if="!rememberedGrants.length && !undo" class="text-xs text-muted-foreground">
            {{ languages.SETTINGS_PERMISSIONS_EMPTY }}
          </p>

          <Collapsible v-else v-model:open="listOpen" class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <CollapsibleTrigger
                class="flex flex-1 min-w-0 items-center gap-2 text-left rounded-md -ml-1 px-1 py-0.5 hover:bg-muted/60"
              >
                <ChevronRightIcon
                  class="size-4 flex-none text-muted-foreground transition-transform"
                  :class="{ 'rotate-90': listOpen }"
                />
                <SettingsHeading sub>{{
                  languages.SETTINGS_PERMISSIONS_REMEMBERED
                }}</SettingsHeading>
                <span class="text-xs text-muted-foreground">({{ rememberedGrants.length }})</span>
              </CollapsibleTrigger>
              <DropdownMenu v-if="rememberedGrants.length">
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7 text-muted-foreground hover:text-foreground"
                    :aria-label="languages.SETTINGS_PERMISSIONS_MORE_ACTIONS"
                  >
                    <EllipsisVerticalIcon class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="min-w-[180px] z-[100]">
                  <DropdownMenuItem
                    class="text-destructive focus:text-destructive"
                    @select="revokeAll"
                  >
                    <TrashIcon />
                    {{ languages.SETTINGS_PERMISSIONS_REVOKE_ALL }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div
              v-if="undo"
              role="status"
              class="flex items-center justify-between gap-4 rounded-md bg-muted/60 px-2 py-1.5 text-xs"
            >
              <span>{{
                fillTemplate(languages.SETTINGS_PERMISSIONS_REVOKED, {
                  count: String(undo.grants.length),
                })
              }}</span>
              <Button variant="ghost" size="sm" class="h-6 px-2" @click="undoRevoke">
                {{ languages.SETTINGS_PERMISSIONS_UNDO }}
              </Button>
            </div>

            <CollapsibleContent class="flex flex-col gap-3">
              <div v-for="group in groups" :key="group.id" class="flex flex-col gap-1.5">
                <span class="text-xs font-medium text-muted-foreground">{{ group.title }}</span>
                <div
                  v-for="grant in group.grants"
                  :key="grant.key"
                  class="flex justify-between items-center gap-4"
                >
                  <div class="flex flex-col min-w-0">
                    <span class="text-sm truncate">{{ grant.label }}</span>
                    <span class="text-xs text-muted-foreground">{{
                      fillTemplate(languages.SETTINGS_PERMISSIONS_REMEMBERED_ON, {
                        date: formatDate(grant.createdAt),
                      })
                    }}</span>
                  </div>
                  <Button variant="outline" size="sm" @click="revoke(grant)">
                    {{ languages.SETTINGS_PERMISSIONS_REVOKE }}
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  </DemoModeBlocker>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ChevronRightIcon, EllipsisVerticalIcon, TrashIcon } from '@heroicons/vue/24/outline'
import {
  REMOTE_DOWNLOAD_GRANT,
  usePermissionGrants,
  VRAM_WARNING_GRANT_PREFIX,
  type PermissionGrant,
} from '@/assets/js/store/permissionGrants'
import { useChannels } from '@/assets/js/store/channels'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import SettingsHeading from '@/components/SettingsHeading.vue'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'
import { createAppError } from '@/assets/js/errors/appError'
import { fillTemplate } from '@/lib/fillTemplate'

const grants = usePermissionGrants()
const channelStore = useChannels()
const setupWizard = useSetupWizard()
const errors = useErrors()
const languages = useI18N().state

const UNDO_WINDOW_MS = 8000

type GrantGroupId = 'vram-warning' | 'other'

type GrantGroup = {
  id: GrantGroupId
  title: string
  grants: (PermissionGrant & { label: string })[]
}

const listOpen = ref(false)
const undo = ref<{ grants: PermissionGrant[]; timer: ReturnType<typeof setTimeout> } | null>(null)

const remoteDownloadsGranted = computed(() => grants.has(REMOTE_DOWNLOAD_GRANT))

const rememberedGrants = computed<PermissionGrant[]>(() =>
  grants.list.filter((grant) => grant.origin === 'remember'),
)

const groups = computed<GrantGroup[]>(() => {
  const vram: GrantGroup = {
    id: 'vram-warning',
    title: languages.SETTINGS_PERMISSIONS_VRAM_GROUP,
    grants: [],
  }
  const other: GrantGroup = {
    id: 'other',
    title: languages.SETTINGS_PERMISSIONS_OTHER_GROUP,
    grants: [],
  }
  for (const grant of rememberedGrants.value) {
    if (grant.key.startsWith(VRAM_WARNING_GRANT_PREFIX)) {
      vram.grants.push({ ...grant, label: grant.key.slice(VRAM_WARNING_GRANT_PREFIX.length) })
    } else {
      other.grants.push({ ...grant, label: grant.key })
    }
  }
  return [vram, other].filter((group) => group.grants.length > 0)
})

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function reportFailure(technicalMessage: string | undefined): void {
  errors.report(
    createAppError({
      category: 'unknown',
      code: 'permissions/update-failed',
      surface: 'toast',
      userMessage: languages.SETTINGS_PERMISSIONS_UPDATE_FAILED,
      technicalMessage,
    }),
  )
}

async function setRemoteDownloads(enabled: boolean): Promise<void> {
  const result = enabled
    ? await grants.grant(REMOTE_DOWNLOAD_GRANT, 'pre-grant')
    : await grants.revoke(REMOTE_DOWNLOAD_GRANT)
  if (!result.success) reportFailure(result.error)
}

function setUndo(pending: PermissionGrant[]): void {
  clearUndo()
  if (!pending.length) return
  undo.value = { grants: pending, timer: setTimeout(clearUndo, UNDO_WINDOW_MS) }
}

function offerUndo(revoked: PermissionGrant[]): void {
  setUndo([...(undo.value?.grants ?? []), ...revoked])
}

function clearUndo(): void {
  if (undo.value) clearTimeout(undo.value.timer)
  undo.value = null
}

async function revoke(grant: PermissionGrant): Promise<void> {
  const result = await grants.revoke(grant.key)
  if (result.success) offerUndo([grant])
  else reportFailure(result.error)
}

async function revokeAll(): Promise<void> {
  const batch = await grants.revokeAll([...rememberedGrants.value])
  offerUndo(batch.done)
  if (batch.failed.length) reportFailure(batch.error)
}

async function undoRevoke(): Promise<void> {
  const batch = await grants.restoreAll(undo.value?.grants ?? [])
  setUndo(batch.failed)
  if (batch.failed.length) reportFailure(batch.error)
}

onBeforeUnmount(clearUndo)
</script>
