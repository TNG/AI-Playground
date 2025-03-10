<template>
  <div class="flex flex-col gap-2">
    <p>{{ languages.SETTINGS_LLM_BACKEND }}</p>
    <div class="flex items-center gap-2">
      <drop-selector
        :array="[...llmBackendTypes]"
        @change="(item) => (textInference.backend = item)"
      >
        <template #selected>
          <div class="flex gap-2 items-center">
            <span
              class="rounded-full w-2 h-2"
              :class="{
                'bg-green-500': isRunning(textInference.backend),
                'bg-gray-500': !isRunning(textInference.backend),
              }"
            ></span>
            <span>{{ textInferenceBackendDisplayName[textInference.backend] }}</span>
            <!--       Flag LlamaCpp as experimental       -->
            <span
              v-if="textInference.backend == 'llamaCPP'"
              class="rounded-lg h-4 px-1 text-xs"
              :style="{ 'background-color': '#cc00ff88' }"
            >
              Experimental</span
            >
          </div>
        </template>
        <template #list="slotItem">
          <div class="flex gap-2 items-center">
            <span
              class="rounded-full w-2 h-2"
              :class="{
                'bg-green-500': isRunning(slotItem.item),
                'bg-gray-500': !isRunning(slotItem.item),
              }"
            ></span>
            <span>{{
              textInferenceBackendDisplayName[slotItem.item as (typeof llmBackendTypes)[number]]
            }}</span>
            <span
              v-if="slotItem.item == 'llamaCPP'"
              class="rounded-lg h-4 px-1 text-xs"
              :style="{ 'background-color': '#cc00ff88' }"
            >
              Experimental</span
            >
          </div>
        </template>
      </drop-selector>
    </div>
  </div>
  <div class="flex items-center gap-5">
    <p>{{ languages.SETTINGS_LLM_PERFORMANCE_METRICS }}</p>
    <button
      class="v-checkbox-control flex-none w-5 h-5"
      :class="{ 'v-checkbox-checked': textInference.metricsEnabled }"
      @click="textInference.toggleMetrics()"
    ></button>
  </div>
  <div class="flex flex-col gap-2">
    <p>{{ languages.SETTINGS_LLM_MAX_TOKENS }}</p>
    <slide-bar v-model:current="textInference.maxTokens" :min="0" :max="4096" :step="1"></slide-bar>
  </div>
</template>
<script setup lang="ts">
import DropSelector from '../components/DropSelector.vue'
import { useTextInference, llmBackendTypes, LlmBackend } from '@/assets/js/store/textInference'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import SlideBar from '../components/SlideBar.vue'

const textInference = useTextInference()
const backendServices = useBackendServices()

const textInferenceBackendDisplayName: Record<(typeof llmBackendTypes)[number], string> = {
  ipexLLM: 'IPEX-LLM',
  llamaCPP: 'llamaCPP - GGUF',
  openVINO: 'OpenVINO',
}

function mapBackendNames(name: LlmBackend): BackendServiceName | undefined {
  if (name === 'ipexLLM') {
    return 'ai-backend' as BackendServiceName
  } else if (name === 'llamaCPP') {
    return 'llamacpp-backend' as BackendServiceName
  } else if (name === 'openVINO') {
    return 'openvino-backend' as BackendServiceName
  } else {
    return undefined
  }
}

function isRunning(name: LlmBackend) {
  const backendName: BackendServiceName | undefined = mapBackendNames(name)
  return backendServices.info.find((item) => item.serviceName === backendName)?.status === 'running'
}
</script>
