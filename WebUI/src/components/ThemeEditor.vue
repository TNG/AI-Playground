<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <AppSettingsRow :label="languages.COM_THEME">
        <ThemePicker />
      </AppSettingsRow>

      <ThemeFallbackNotice />

      <div v-if="!edited" class="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>{{ languages.SETTINGS_THEME_BUILT_IN_READ_ONLY }}</p>
        <Button variant="outline" size="sm" @click="theme.customize()">
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
              <Button variant="ghost" @click="renameOpen = false">{{
                languages.COM_CANCEL
              }}</Button>
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

      <ThemeAdvancedColors v-else :aria-label="languages.SETTINGS_THEME_ADVANCED" />

      <div
        v-if="theme.holdMessage"
        role="alert"
        class="flex flex-col items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs"
      >
        <p class="flex items-start gap-2">
          <ExclamationTriangleIcon class="size-4 shrink-0 text-destructive" />
          {{ theme.holdMessage }}
        </p>
        <Button v-if="theme.holdFix" variant="outline" size="sm" @click="theme.applyHoldFix()">
          {{
            theme.holdFix.color === '#ffffff'
              ? languages.SETTINGS_THEME_FIX_WHITE
              : languages.SETTINGS_THEME_FIX_BLACK
          }}
        </Button>
      </div>
    </div>

    <div
      v-if="theme.hasUnsavedChanges"
      role="region"
      :aria-label="languages.SETTINGS_THEME_UNSAVED_CHANGES"
      class="flex items-center justify-between gap-4 border-t border-border px-4 py-3"
    >
      <span class="text-sm font-medium">{{ languages.SETTINGS_THEME_UNSAVED_CHANGES }}</span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" @click="theme.discardDraft()">
          {{ languages.SETTINGS_THEME_DISCARD }}
        </Button>
        <Button size="sm" :disabled="!theme.canSave" @click="theme.saveDraft()">
          {{ languages.SETTINGS_THEME_SAVE }}
        </Button>
      </div>
    </div>

    <AlertDialog v-model:open="toSimpleOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ languages.SETTINGS_THEME_TO_SIMPLE_TITLE }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{
              fillTemplate(languages.SETTINGS_THEME_TO_SIMPLE_BODY, {
                count: theme.simpleModeRecalculates.length,
                colors: theme.simpleModeRecalculates
                  .map((token) => languages[colorLabelKeys[token]])
                  .join(', '),
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
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useTheme, type EditingMode } from '@/assets/js/store/theme'
import { useI18N } from '@/assets/js/store/i18n'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import ThemeAdvancedColors from '@/components/ThemeAdvancedColors.vue'
import ThemeColorRow from '@/components/ThemeColorRow.vue'
import ThemeFallbackNotice from '@/components/ThemeFallbackNotice.vue'
import ThemePicker from '@/components/ThemePicker.vue'
import { Button } from '@/components/ui/button'
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
import { colorLabelKeys } from '@/lib/themeAdvancedGroups'
import type { MainColorToken } from '@/lib/themeDerivation'

const theme = useTheme()
const languages = useI18N().state
const edited = computed(() => theme.editedCustomTheme)

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
</script>
