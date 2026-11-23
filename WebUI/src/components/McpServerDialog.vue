<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="sm:max-w-[425px]">
      <DialogHeader>
        <DialogTitle>MCP Server Configuration</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-4 py-4">
        <p v-if="errorMessage" class="text-sm text-destructive">
          {{ errorMessage }}
        </p>

        <div class="flex flex-col gap-2">
          <Label>Transport</Label>
          <RadioGroup v-model="transport" class="flex gap-4">
            <div class="flex items-center gap-2">
              <RadioGroupItem id="transport-stdio" value="stdio" />
              <Label for="transport-stdio" class="cursor-pointer">stdio</Label>
            </div>
            <div class="flex items-center gap-2">
              <RadioGroupItem id="transport-http" value="http" />
              <Label for="transport-http" class="cursor-pointer">http</Label>
            </div>
          </RadioGroup>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="display-name">Display Name *</Label>
          <Input id="display-name" v-model="displayName" placeholder="My MCP Server" />
        </div>

        <div v-if="transport === 'stdio'" class="flex flex-col gap-2">
          <Label for="command">Command *</Label>
          <Input id="command" v-model="command" placeholder="uvx" />
          <span class="text-xs text-muted-foreground">
            Executable to run (e.g., uvx, python, node). Paths are escaped automatically.
          </span>
        </div>

        <div v-if="transport === 'stdio'" class="flex flex-col gap-2">
          <Label for="args">Args</Label>
          <Input id="args" v-model="args" placeholder="mcp-server-time" />
          <span class="text-xs text-muted-foreground">{{ languages.SETTINGS_MCP_ARGS_HINT }}</span>
        </div>

        <div v-if="transport === 'stdio'" class="flex flex-col gap-2">
          <Label for="env">{{ languages.SETTINGS_MCP_ENV_LABEL }}</Label>
          <Textarea
            id="env"
            v-model="env"
            rows="3"
            placeholder="API_TOKEN=abc123"
            class="font-mono text-xs"
          />
          <span class="text-xs text-muted-foreground">{{ languages.SETTINGS_MCP_ENV_HINT }}</span>
        </div>

        <div v-if="transport === 'http'" class="flex flex-col gap-2">
          <Label for="url">URL *</Label>
          <Input id="url" v-model="url" placeholder="https://example.com/mcp" />
        </div>

        <div v-if="transport === 'http'" class="flex flex-col gap-2">
          <Label for="headers">{{ languages.SETTINGS_MCP_HEADERS_LABEL }}</Label>
          <Textarea
            id="headers"
            v-model="headers"
            rows="3"
            placeholder="Authorization: Bearer token"
            class="font-mono text-xs"
          />
          <span class="text-xs text-muted-foreground">{{
            languages.SETTINGS_MCP_HEADERS_HINT
          }}</span>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="instructions">Instructions (optional)</Label>
          <Textarea
            id="instructions"
            v-model="instructions"
            rows="4"
            placeholder="e.g. Always call get_current_time before answering time-related questions."
          />
          <span class="text-xs text-muted-foreground">
            Sent to the model as part of the system prompt when this server is connected. Useful for
            telling smaller models when and how to use this server's tools.
          </span>
        </div>
      </div>

      <div class="flex justify-between gap-2">
        <div class="flex gap-2">
          <Button
            v-if="!isAddMode"
            variant="destructive"
            :disabled="isSubmitting"
            @click="handleRemove"
          >
            Remove
          </Button>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" @click="handleClose">Cancel</Button>
          <Button :disabled="isSubmitting" @click="handleSubmit">
            {{
              isSubmitting
                ? isAddMode
                  ? 'Adding...'
                  : 'Updating...'
                : isAddMode
                  ? 'Add Server'
                  : 'Update Server'
            }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useMcp } from '@/assets/js/store/mcp'
import { splitParameterString } from '@/lib/parameterString'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import * as toast from '@/assets/js/toast'
import type { McpServerConfig } from '@/types/mcpIpc'

const props = defineProps<{
  open: boolean
  editServer?: { id: string; config: McpServerConfig }
}>()

const isAddMode = computed(() => props.editServer === undefined)

const emits = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'added'): void
}>()

const mcp = useMcp()
const errors = useErrors()
const languages = useI18N().state

const transport = ref<'stdio' | 'http'>('stdio')
const displayName = ref('')
const command = ref('')
const args = ref('')
const url = ref('')
const env = ref('')
const headers = ref('')
const instructions = ref('')
const errorMessage = ref('')
const isSubmitting = ref(false)

function stringifyLines(map: Record<string, string> | undefined, joiner: string): string {
  return Object.entries(map ?? {})
    .map(([key, value]) => `${key}${joiner}${value}`)
    .join('\n')
}

function stringifyArgs(list: string[]): string {
  return list.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')
}

function populateFormFromConfig(config: McpServerConfig) {
  displayName.value = config.displayName ?? ''
  instructions.value = config.instructions ?? ''
  env.value = config.type !== 'http' ? stringifyLines(config.env, '=') : ''
  headers.value = config.type === 'http' ? stringifyLines(config.headers, ': ') : ''
  if (config.type !== 'http') {
    transport.value = 'stdio'
    command.value = config.command
    args.value = stringifyArgs(config.args ?? [])
    url.value = ''
  } else {
    transport.value = 'http'
    url.value = config.url
    command.value = ''
    args.value = ''
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    const editServer = props.editServer
    if (editServer === undefined) {
      resetForm()
    } else {
      populateFormFromConfig(editServer.config)
    }
  },
)

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emits('update:open', value),
})

function resetForm() {
  transport.value = 'stdio'
  displayName.value = ''
  command.value = ''
  args.value = ''
  url.value = ''
  env.value = ''
  headers.value = ''
  instructions.value = ''
  errorMessage.value = ''
}

function parseArgs(argsInput: string): string[] {
  return splitParameterString(argsInput)
}

function parseLines(
  input: string,
  separator: string,
  invalidTemplate: string,
): Record<string, string> | null {
  const map: Record<string, string> = {}
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf(separator)
    const key = at > 0 ? trimmed.slice(0, at).trim() : ''
    if (!key) {
      errorMessage.value = fillTemplate(invalidTemplate, { line: trimmed })
      return null
    }
    map[key] = trimmed.slice(at + 1).trim()
  }
  return map
}

function generateUniqueId(baseName: string): string {
  const baseId = baseName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  let id = baseId
  let counter = 1

  while (mcp.allServers.some((s) => s.id === id)) {
    id = `${baseId}-${counter}`
    counter++
  }

  return id
}

function getServerId(): string {
  const editServer = props.editServer
  if (editServer === undefined) {
    return generateUniqueId(displayName.value.trim())
  }
  return editServer.id
}

function sharedFields(name: string) {
  const trimmedInstructions = instructions.value.trim()
  // `description` (auto-detect, hand-edit) has no editor here — preserve it.
  const description = props.editServer?.config.description
  return {
    displayName: name,
    ...(description !== undefined ? { description } : {}),
    ...(trimmedInstructions ? { instructions: trimmedInstructions } : {}),
  }
}

function buildStdioConfig(name: string, cmd: string): McpServerConfig | null {
  const envVars = parseLines(env.value, '=', languages.SETTINGS_MCP_ENV_INVALID)
  if (envVars === null) return null
  return {
    command: cmd,
    args: parseArgs(args.value),
    ...sharedFields(name),
    ...(Object.keys(envVars).length > 0 ? { env: envVars } : {}),
  }
}

function buildHttpConfig(name: string, httpUrl: string): McpServerConfig | null {
  const headerMap = parseLines(headers.value, ':', languages.SETTINGS_MCP_HEADERS_INVALID)
  if (headerMap === null) return null
  return {
    type: 'http',
    url: httpUrl,
    ...sharedFields(name),
    ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
  }
}

async function handleSubmit() {
  errorMessage.value = ''

  const name = displayName.value.trim()
  const cmd = command.value.trim()
  const httpUrl = url.value.trim()

  if (!name) {
    errorMessage.value = 'Display Name is required'
    return
  }

  if (transport.value === 'stdio' && !cmd) {
    errorMessage.value = 'Command is required for stdio transport'
    return
  }

  if (transport.value === 'http' && !httpUrl) {
    errorMessage.value = 'URL is required for http transport'
    return
  }

  const id = getServerId()
  const config =
    transport.value === 'http' ? buildHttpConfig(name, httpUrl) : buildStdioConfig(name, cmd)
  if (!config) return

  isSubmitting.value = true

  try {
    if (isAddMode.value) {
      await handleAdd(id, config, name)
    } else {
      await handleUpdate(id, config, name)
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error
        ? error.message
        : `Failed to ${isAddMode.value ? 'add' : 'update'} server`
    // The dialog renders errorMessage inline, so report as 'inline' to centralize
    // logging/de-duplication without a redundant toast.
    errors.report(error, {
      category: 'backend',
      code: `backend/mcp-${isAddMode.value ? 'add' : 'update'}-failed`,
      surface: 'inline',
      userMessage: errorMessage.value,
    })
  } finally {
    isSubmitting.value = false
  }
}

async function handleAdd(id: string, config: McpServerConfig, name: string) {
  await window.electronAPI.mcp.addServer(id, config)
  await mcp.refreshAvailableServers()
  toast.success(fillTemplate(languages.SETTINGS_MCP_SERVER_ADDED, { name }))
  resetForm()
  emits('update:open', false)
  emits('added')
}

async function handleUpdate(id: string, config: McpServerConfig, name: string) {
  await window.electronAPI.mcp.updateServer(id, config)
  await mcp.refreshAvailableServers()
  toast.success(fillTemplate(languages.SETTINGS_MCP_SERVER_UPDATED, { name }))
  resetForm()
  emits('update:open', false)
  emits('added')
}

async function handleRemove() {
  const editServer = props.editServer
  if (editServer === undefined) return
  isSubmitting.value = true
  try {
    await window.electronAPI.mcp.removeServer(editServer.id)
    mcp.forgetServer(editServer.id)
    toast.success(languages.SETTINGS_MCP_SERVER_REMOVED)
    emits('update:open', false)
    resetForm()
  } catch (error) {
    errors.report(error, {
      category: 'backend',
      code: 'backend/mcp-remove-failed',
      userMessage: error instanceof Error ? error.message : languages.SETTINGS_MCP_REMOVE_FAILED,
    })
  } finally {
    isSubmitting.value = false
  }
}

function handleClose() {
  resetForm()
  emits('update:open', false)
}
</script>
