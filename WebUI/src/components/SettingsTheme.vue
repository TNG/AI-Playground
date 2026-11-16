<template>
  <div class="flex flex-col gap-4">
    <SettingsHeading>{{ languages.COM_THEME }}</SettingsHeading>
    <AppSettingsRow :label="languages.COM_THEME">
      <DropDownNew
        :items="themeItems"
        :value="theme.selectedId"
        @change="(value: string) => theme.guardUnsaved(() => theme.selectTheme(value))"
      />
    </AppSettingsRow>

    <p
      v-if="theme.fallbackMessage"
      role="status"
      class="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs"
    >
      <ExclamationTriangleIcon class="size-4 shrink-0 text-destructive" />
      {{ theme.fallbackMessage }}
    </p>

    <div v-if="!edited" class="flex flex-col items-start gap-2 text-xs text-muted-foreground">
      <p>{{ languages.SETTINGS_THEME_BUILT_IN_READ_ONLY }}</p>
      <Button variant="outline" size="sm" @click="customize">
        {{ languages.SETTINGS_THEME_CUSTOMIZE }}
      </Button>
    </div>

    <div v-else class="flex flex-wrap gap-2">
      <Dialog v-model:open="renameOpen">
        <DialogTrigger as-child>
          <Button variant="outline" size="sm" @click="renameName = edited.name">
            {{ languages.SETTINGS_THEME_RENAME }}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{{ languages.SETTINGS_THEME_RENAME_TITLE }}</DialogTitle>
          </DialogHeader>
          <Input
            v-model="renameName"
            autofocus
            type="text"
            :aria-label="languages.SETTINGS_THEME_NAME_PLACEHOLDER"
            :placeholder="languages.SETTINGS_THEME_NAME_PLACEHOLDER"
            @keydown.enter.prevent="saveRename"
          />
          <DialogFooter>
            <Button variant="ghost" @click="renameOpen = false">{{ languages.COM_CANCEL }}</Button>
            <Button :disabled="!renameName.trim()" @click="saveRename">
              {{ languages.SETTINGS_THEME_SAVE_NAME }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button variant="outline" size="sm" @click="copyEdited">
        {{ languages.COM_COPY }}
      </Button>

      <AlertDialog>
        <AlertDialogTrigger as-child>
          <Button variant="outline" size="sm">
            {{ fillTemplate(languages.SETTINGS_THEME_RESET, { theme: resetTargetName }) }}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {{ fillTemplate(languages.SETTINGS_THEME_RESET_TITLE, { name: edited.name }) }}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {{ fillTemplate(languages.SETTINGS_THEME_RESET_BODY, { theme: resetTargetName }) }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ languages.COM_CANCEL }}</AlertDialogCancel>
            <AlertDialogAction @click="theme.resetCustomTheme(edited.id)">
              {{ languages.SETTINGS_THEME_RESET_CONFIRM }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog>
        <AlertDialogTrigger as-child>
          <Button variant="outline" size="sm">{{ languages.COM_DELETE }}</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {{ fillTemplate(languages.SETTINGS_THEME_DELETE_TITLE, { name: edited.name }) }}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {{ fillTemplate(languages.SETTINGS_THEME_DELETE_BODY, { theme: resetTargetName }) }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ languages.COM_CANCEL }}</AlertDialogCancel>
            <AlertDialogAction @click="theme.deleteCustomTheme(edited.id)">
              {{ languages.COM_DELETE }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>

    <Collapsible
      :open="customizerOpen"
      class="flex flex-col gap-4"
      @update:open="setCustomizerOpen"
    >
      <CollapsibleTrigger as-child>
        <Button variant="outline" size="sm" class="self-start">
          <ChevronDownIcon
            class="size-4 transition-transform"
            :class="{ 'rotate-180': customizerOpen }"
          />
          {{ languages.SETTINGS_THEME_EDIT_COLORS }}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent class="flex flex-col gap-4">
        <div
          role="group"
          :aria-label="languages.SETTINGS_THEME_MODE"
          class="flex self-start rounded-md border p-0.5"
        >
          <Button
            v-for="mode in editingModes"
            :key="mode"
            size="sm"
            :variant="theme.editingMode === mode ? 'secondary' : 'ghost'"
            :aria-pressed="theme.editingMode === mode"
            @click="chooseMode(mode)"
          >
            {{ languages[modeLabelKeys[mode]] }}
          </Button>
        </div>

        <section
          v-if="theme.editingMode === 'simple'"
          class="flex flex-col gap-2"
          :aria-label="languages.SETTINGS_THEME_SIMPLE"
        >
          <ul class="flex flex-col gap-1.5 pl-1">
            <ThemeColorRow
              v-for="token in theme.mainColorTokens"
              :id="`theme-main-${token}`"
              :key="token"
              :label="languages[mainColorLabelKeys[token]]"
              :value="theme.draftHexColors[token]"
              @pick="(hex) => theme.setColor(token, hex)"
            />
          </ul>
          <p class="text-xs text-muted-foreground">{{ languages.SETTINGS_THEME_SIMPLE_HINT }}</p>
        </section>

        <section v-else class="flex flex-col gap-2" :aria-label="languages.SETTINGS_THEME_ADVANCED">
          <ul class="flex flex-col gap-1.5 pl-1">
            <ThemeColorRow
              v-for="token in theme.colorTokens"
              :id="`theme-token-${token}`"
              :key="token"
              :label="token"
              mono-label
              :value="theme.draftHexColors[token]"
              @pick="(hex) => theme.setColor(token, hex)"
            />
          </ul>
        </section>

        <section class="flex flex-col gap-2" :aria-label="languages.SETTINGS_THEME_PREVIEW">
          <h3 class="text-sm font-medium">{{ languages.SETTINGS_THEME_PREVIEW }}</h3>
          <div
            class="flex flex-col gap-2 rounded-md border p-3 text-xs"
            :style="{ backgroundColor: draft.background, borderColor: draft.border }"
          >
            <span :style="{ color: draft.foreground }">{{
              languages.SETTINGS_THEME_MAIN_TEXT
            }}</span>
            <div
              class="flex items-center justify-between gap-2 rounded-md border p-2"
              :style="{
                backgroundColor: draft.card,
                color: draft['card-foreground'],
                borderColor: draft.border,
              }"
            >
              {{ languages.SETTINGS_THEME_MAIN_PANELS }}
              <span
                class="rounded-md px-2 py-1"
                :style="{ backgroundColor: draft.primary, color: draft['primary-foreground'] }"
              >
                {{ languages.SETTINGS_THEME_MAIN_ACCENT }}
              </span>
            </div>
          </div>
        </section>

        <p
          v-if="theme.draftWarning"
          role="alert"
          class="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs"
        >
          <ExclamationTriangleIcon class="size-4 shrink-0 text-destructive" />
          {{ theme.draftWarning }}
        </p>
      </CollapsibleContent>
    </Collapsible>

    <AlertDialog v-model:open="toSimpleOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ languages.SETTINGS_THEME_TO_SIMPLE_TITLE }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{
              fillTemplate(languages.SETTINGS_THEME_TO_SIMPLE_BODY, {
                count: theme.simpleModeRecalculates.length,
                colors: theme.simpleModeRecalculates.join(', '),
              })
            }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ languages.COM_CANCEL }}</AlertDialogCancel>
          <AlertDialogAction @click="theme.setEditingMode('simple')">
            {{ languages.SETTINGS_THEME_TO_SIMPLE_CONFIRM }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog
      :open="theme.discardPending"
      @update:open="(open) => open || theme.cancelDiscard()"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ languages.SETTINGS_THEME_DISCARD_TITLE }}</AlertDialogTitle>
          <AlertDialogDescription>{{
            languages.SETTINGS_THEME_DISCARD_BODY
          }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ languages.COM_CANCEL }}</AlertDialogCancel>
          <AlertDialogAction @click="theme.confirmDiscard()">
            {{ languages.SETTINGS_THEME_DISCARD }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDownIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useTheme, type EditingMode } from '@/assets/js/store/theme'
import { useI18N } from '@/assets/js/store/i18n'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import ThemeColorRow from '@/components/ThemeColorRow.vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { fillTemplate } from '@/lib/fillTemplate'
import type { MainColorToken } from '@/lib/themeDerivation'

const theme = useTheme()
const languages = useI18N().state
const customizerOpen = ref(false)
const edited = computed(() => theme.editedCustomTheme)
const draft = computed(() => theme.draftHexColors)

function setCustomizerOpen(open: boolean) {
  if (open) customizerOpen.value = true
  else theme.guardUnsaved(() => (customizerOpen.value = false))
}

function customize() {
  theme.customize()
  customizerOpen.value = true
}

defineExpose({ openCustomizer: () => setCustomizerOpen(true) })

function copyEdited() {
  const id = edited.value?.id
  if (id) theme.guardUnsaved(() => theme.copyCustomTheme(id))
}

const editingModes: EditingMode[] = ['simple', 'advanced']

const modeLabelKeys: Record<EditingMode, string> = {
  simple: 'SETTINGS_THEME_SIMPLE',
  advanced: 'SETTINGS_THEME_ADVANCED',
}

const mainColorLabelKeys: Record<MainColorToken, string> = {
  background: 'SETTINGS_THEME_MAIN_BACKGROUND',
  card: 'SETTINGS_THEME_MAIN_PANELS',
  foreground: 'SETTINGS_THEME_MAIN_TEXT',
  primary: 'SETTINGS_THEME_MAIN_ACCENT',
  'primary-foreground': 'SETTINGS_THEME_MAIN_ACCENT_TEXT',
}

const toSimpleOpen = ref(false)

function chooseMode(mode: EditingMode) {
  if (mode === 'simple' && theme.simpleModeRecalculates.length) toSimpleOpen.value = true
  else theme.setEditingMode(mode)
}

const renameOpen = ref(false)
const renameName = ref('')

const resetTargetName = computed(() => {
  const id = edited.value?.id
  return (id && theme.resetTargetFor(id)?.name) || ''
})

function saveRename() {
  const id = edited.value?.id
  if (id && theme.renameCustomTheme(id, renameName.value)) renameOpen.value = false
}

const themeItems = computed(() =>
  [...theme.builtInThemes, ...theme.validCustomThemes].map((t) => ({
    label: t.name,
    value: t.id,
    active: true,
  })),
)
</script>
