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
            Executable to run (e.g., uvx, python, node)
          </span>
        </div>

        <div v-if="transport === 'stdio'" class="flex flex-col gap-2">
          <Label for="args">Args</Label>
          <Input id="args" v-model="args" placeholder="mcp-server-time" />
          <span class="text-xs text-muted-foreground">
            Space-separated arguments (e.g. "--port 8080 --verbose")
          </span>
        </div>

        <div v-if="transport === 'http'" class="flex flex-col gap-2">
          <Label for="url">URL *</Label>
          <Input id="url" v-model="url" placeholder="https://example.com/mcp" />
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="outline" @click="handleClose">Cancel</Button>
        <Button :disabled="isSubmitting" @click="handleAdd">
          {{ isSubmitting ? 'Adding...' : 'Add Server' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useMcp } from '@/assets/js/store/mcp'
import * as toast from '@/assets/js/toast'

const props = defineProps<{
  open: boolean
}>()

const emits = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'added'): void
}>()

const mcp = useMcp()

const transport = ref<'stdio' | 'http'>('stdio')
const displayName = ref('')
const command = ref('')
const args = ref('')
const url = ref('')
const errorMessage = ref('')
const isSubmitting = ref(false)

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
  errorMessage.value = ''
}

function parseArgs(argsInput: string): string[] {
  return argsInput
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s)
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

async function handleAdd() {
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

  const id = generateUniqueId(name)

  isSubmitting.value = true

  try {
    switch (transport.value) {
      case 'stdio': {
        const parsedArgs = parseArgs(args.value)
        await window.electronAPI.mcp.addServer(id, {
          command: cmd,
          args: parsedArgs,
          displayName: name,
        })
        break
      }
      case 'http':
        await window.electronAPI.mcp.addServer(id, {
          type: 'http',
          url: httpUrl,
          displayName: name,
        })
        break
    }

    await mcp.reloadConfig()
    toast.success(`MCP server "${name}" added`)
    resetForm()
    emits('update:open', false)
    emits('added')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to add server'
    toast.error(errorMessage.value)
  } finally {
    isSubmitting.value = false
  }
}

function handleClose() {
  resetForm()
  emits('update:open', false)
}
</script>
