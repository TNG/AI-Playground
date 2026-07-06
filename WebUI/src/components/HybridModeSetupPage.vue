<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">Hybrid Mode Setup</h1>
    <p class="text-center text-xs text-muted-foreground pt-2">
      Connect a remote OpenAI-compatible provider. Models are fetched from the provider and become
      selectable in chat under the <span class="font-semibold">Hybrid Mode</span> backend.
    </p>

    <div class="flex gap-6 pt-6">
      <!-- Left: provider list -->
      <div class="w-56 shrink-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Providers
        </h2>
        <div class="flex flex-col gap-2">
          <div
            v-for="provider in hybridMode.providers"
            :key="provider.id"
            class="flex flex-col gap-1 p-3 rounded-lg border cursor-pointer transition-colors"
            :class="
              selectedId === provider.id
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-muted'
            "
            @click="selectProvider(provider.id)"
          >
            <span class="text-sm font-medium">{{ provider.name }}</span>
            <span class="text-xs text-muted-foreground truncate">
              {{ provider.baseUrl || 'Not configured' }}
            </span>
            <span
              v-if="provider.models.length"
              class="text-[10px] font-semibold uppercase tracking-wider text-emerald-500"
            >
              {{ provider.models.length }} models
            </span>
          </div>
        </div>
        <Button variant="secondary" class="mt-3 w-full" @click="addProvider">
          + Add provider
        </Button>
      </div>

      <!-- Right: selected provider settings -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between pb-3">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Provider Settings
          </h2>
          <Button
            variant="ghost"
            class="text-destructive hover:text-destructive"
            :disabled="hybridMode.providers.length <= 1"
            @click="removeSelectedProvider"
          >
            Remove provider
          </Button>
        </div>

        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-[120px_1fr] items-center gap-4">
            <Label>Name</Label>
            <Input v-model="form.name" placeholder="Custom" />
          </div>
          <div class="grid grid-cols-[120px_1fr] items-center gap-4">
            <Label>Base URL</Label>
            <Input v-model="form.baseUrl" placeholder="https://your-provider.example.com" />
          </div>
          <div class="grid grid-cols-[120px_1fr] items-center gap-4">
            <Label>API Key</Label>
            <Input
              v-model="form.apiKey"
              type="password"
              :placeholder="hasStoredKey ? '•••••••• (leave blank to keep)' : 'sk-…'"
            />
          </div>

          <div class="flex items-center gap-3">
            <Button
              variant="secondary"
              :disabled="fetching || !form.baseUrl.trim()"
              @click="fetchModels"
            >
              <span v-if="fetching" class="svg-icon i-loading w-4 h-4 mr-1"></span>
              {{ fetching ? 'Fetching…' : 'Fetch models' }}
            </Button>
            <span v-if="fetchError" class="text-xs text-destructive">{{ fetchError }}</span>
          </div>

          <!-- Fetched models preview -->
          <div v-if="form.models.length" class="rounded-md border border-border p-3">
            <p class="text-xs font-semibold text-muted-foreground pb-2">
              Available models ({{ form.models.length }})
            </p>
            <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto">
              <li v-for="m in form.models" :key="m" class="text-sm text-foreground">{{ m }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer actions -->
    <div class="flex items-center justify-between pt-6">
      <button
        @click="emit('back')"
        class="py-2 px-6 rounded text-sm font-medium border border-border hover:bg-muted transition-colors"
      >
        Back
      </button>
      <div class="flex gap-3">
        <Button variant="secondary" @click="saveOnly" :disabled="saving">Save</Button>
        <button
          @click="saveAndDone"
          :disabled="saving"
          class="bg-primary py-2 px-8 rounded text-primary-foreground text-sm font-medium disabled:opacity-50 transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useHybridMode } from '@/assets/js/store/hybridMode'
import { useErrors } from '@/assets/js/store/errors'
import * as toast from '@/assets/js/toast'

const emit = defineEmits<{ (e: 'back'): void; (e: 'done'): void }>()

const hybridMode = useHybridMode()
const errors = useErrors()

const selectedId = ref(hybridMode.selectedProviderId)
const fetching = ref(false)
const fetchError = ref('')
const saving = ref(false)
const hasStoredKey = ref(false)

const form = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  models: [] as string[],
})

function loadForm(id: string) {
  const provider = hybridMode.providers.find((p) => p.id === id)
  if (!provider) return
  form.name = provider.name
  form.baseUrl = provider.baseUrl
  form.apiKey = ''
  form.models = [...provider.models]
  hasStoredKey.value = !!hybridMode.activeProviderApiKey
}

async function selectProvider(id: string) {
  // Persist any edits to the current provider before switching away.
  applyFormToStore()
  selectedId.value = id
  hybridMode.selectProvider(id)
  // Pull the key into the session cache so the placeholder reflects reality.
  await hybridMode.loadApiKey(id).catch(() => null)
  loadForm(id)
}

/** Create a fresh provider, select it, and start editing a blank form. */
function addProvider() {
  // Don't lose edits to the provider we're leaving.
  applyFormToStore()
  const id = crypto.randomUUID()
  hybridMode.addProvider({ id, name: 'New provider', baseUrl: '' })
  selectedId.value = id
  hybridMode.selectProvider(id)
  loadForm(id)
}

/** Remove the selected provider (and its stored key), then select another. */
async function removeSelectedProvider() {
  if (hybridMode.providers.length <= 1) return
  await hybridMode.removeProvider(selectedId.value)
  const nextId = hybridMode.selectedProviderId
  selectedId.value = nextId
  await hybridMode.loadApiKey(nextId).catch(() => null)
  loadForm(nextId)
}

/** Write the in-form name/baseURL/models back onto the selected provider. */
function applyFormToStore() {
  hybridMode.updateProvider(selectedId.value, {
    name: form.name.trim() || 'Custom',
    baseUrl: form.baseUrl.trim(),
    models: form.models,
  })
}

async function fetchModels() {
  fetchError.value = ''
  fetching.value = true
  try {
    applyFormToStore()
    // Persist a freshly-entered key first so fetch can authenticate.
    if (form.apiKey.trim()) {
      await hybridMode.saveApiKey(selectedId.value, form.apiKey.trim())
      hasStoredKey.value = true
      form.apiKey = ''
    }
    const models = await hybridMode.fetchModels(selectedId.value)
    form.models = models
    if (!models.length) toast.warning?.('Provider returned no models.')
  } catch (e) {
    // Route through the central error sink: it logs the technical detail + cause
    // to the console once and returns the normalized AppError. Rendered inline
    // below (surface: 'inline') rather than toasted.
    const appError = errors.report(e, {
      category: 'inference',
      code: 'hybrid/fetch-models-failed',
      surface: 'inline',
    })
    fetchError.value = appError.userMessage
  } finally {
    fetching.value = false
  }
}

async function persist() {
  saving.value = true
  try {
    applyFormToStore()
    if (form.apiKey.trim()) {
      await hybridMode.saveApiKey(selectedId.value, form.apiKey.trim())
      hasStoredKey.value = true
      form.apiKey = ''
    }
  } finally {
    saving.value = false
  }
}

async function saveOnly() {
  await persist()
  toast.success('Provider saved.')
}

async function saveAndDone() {
  await persist()
  emit('done')
}

watch(
  () => hybridMode.selectedProviderId,
  (id) => {
    if (id !== selectedId.value) {
      selectedId.value = id
      loadForm(id)
    }
  },
)

onMounted(async () => {
  // Ensure the stored key (if any) is in the session cache so the placeholder
  // reflects reality after a restart.
  await hybridMode.loadApiKey(selectedId.value).catch(() => null)
  loadForm(selectedId.value)
})
</script>
