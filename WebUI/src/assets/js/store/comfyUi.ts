import { defineStore, acceptHMRUpdate } from "pinia";
import { WebSocket } from "partysocket";
import { ComfyUIApiWorkflow, Setting, useImageGeneration } from "./imageGeneration";
import { useI18N } from "./i18n";
import { toast } from "../toast";
import {useGlobalSetup} from "@/assets/js/store/globalSetup.ts";

const WEBSOCKET_OPEN = 1;

export const useComfyUi = defineStore("comfyUi", () => {

    const comfyUiState = ref<ComfyUiState | null>(null);
    const imageGeneration = useImageGeneration();
    const i18nState = useI18N().state;
    const comfyHostAndPort = computed(() => {
        return `localhost:${comfyUiState.value?.port}`;
    });
    const websocket = ref<WebSocket | null>(null);
    const clientId = '12345';
    const loaderNodes = ref<string[]>([]);

    setInterval(() => void updateComfyState(), 5000);

    async function updateComfyState() {
        const services = await window.electronAPI.getServiceRegistry();
        const comfyUiService = services.find((service) => service.serviceName === 'comfyui-backend');
        if (comfyUiService) {
            const newState = { port: comfyUiService.port, up: comfyUiService.status.status === 'running', currentVersion: '' };
            if (JSON.stringify(comfyUiState.value) !== JSON.stringify(newState)) {
                comfyUiState.value = newState;
                console.log('Received new ComfyUI state from backend', comfyUiState.value);
            }
        }
    }

    function connectToComfyUi() {
        if (!comfyUiState.value) {
            console.warn('ComfyUI backend not running, cannot start websocket');
            return;
        }
        const comfyWsUrl = `ws://localhost:${comfyUiState.value.port}/ws?clientId=${clientId}`
        console.info('Connecting to ComfyUI', { comfyWsUrl });
        websocket.value = new WebSocket(comfyWsUrl);
        websocket.value.binaryType = 'arraybuffer'
        websocket.value.addEventListener('message', (event) => {
            try {
                if (event.data instanceof ArrayBuffer) {
                    const view = new DataView(event.data)
                    const eventType = view.getUint32(0)
                    const buffer = event.data.slice(4)
                    switch (eventType) {
                        case 1:
                            const view2 = new DataView(event.data)
                            const imageType = view2.getUint32(0)
                            let imageMime
                            switch (imageType) {
                                case 1:
                                default:
                                    imageMime = 'image/jpeg'
                                    break
                                case 2:
                                    imageMime = 'image/png'
                            }
                            const imageBlob = new Blob([buffer.slice(4)], {
                                type: imageMime
                            })
                            console.log('got image blob')
                            const imageUrl = URL.createObjectURL(imageBlob)
                            console.log('image url', imageUrl)
                            if (imageBlob) {
                                imageGeneration.previewIdx = imageGeneration.generateIdx;
                                imageGeneration.updateDestImage(imageGeneration.generateIdx, imageUrl);
                            }
                            break
                        default:
                            throw new Error(
                                `Unknown binary websocket message of type ${eventType}`
                            )
                    }
                } else {
                    const msg = JSON.parse(event.data)
                    switch (msg.type) {
                        case 'status':
                            break
                        case 'progress':
                            imageGeneration.currentState = "generating";
                            imageGeneration.stepText = `${i18nState.COM_GENERATING} ${msg.data.value}/${msg.data.max}`;
                            console.log('progress', { data: msg.data })
                            break
                        case 'executing':
                            console.log('executing', {
                                detail: msg.data.display_node || msg.data.node
                            })
                            if (loaderNodes.value.includes(msg?.data?.node)) {
                                imageGeneration.currentState = 'load_model'
                            } else {
                                imageGeneration.currentState = 'generating'
                            }
                            break
                        case 'executed':
                            const images: { filename: string, type: string, subfolder: string }[] = msg.data?.output?.images?.filter((i: { type: string }) => i.type === 'output');
                            images.forEach((image) => {
                                imageGeneration.updateDestImage(imageGeneration.generateIdx, `http://${comfyHostAndPort.value}/view?filename=${image.filename}&type=${image.type}&subfolder=${image.subfolder ?? ''}`);
                                imageGeneration.generateIdx++;
                            });
                            console.log('executed', { detail: msg.data })
                            break
                        case 'execution_start':
                            imageGeneration.processing = true;
                            console.log('execution_start', { detail: msg.data })
                            break
                        case 'execution_success':
                            imageGeneration.processing = false;
                            console.log('execution_success', { detail: msg.data })
                            break
                        case 'execution_error':
                            imageGeneration.processing = false;
                            break
                        case 'execution_interrupted':
                            imageGeneration.processing = false;
                            break
                        case 'execution_cached':
                            break
                    }
                }
            } catch (error) {
                console.warn('Unhandled message:', event.data, error)
            }
        })
    }

    watchEffect(() => {
        if (comfyUiState.value?.port) {
            connectToComfyUi();
        }
    });

    function dataURItoBlob(dataURI: string) {
        const bytes = dataURI.split(',')[0].indexOf('base64') >= 0 ? atob(dataURI.split(',')[1]) : unescape(dataURI.split(',')[1]);
        const mimeType = dataURI.split(',')[0].split(':')[1].split(';')[0];

        const intArray = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            intArray[i] = bytes.charCodeAt(i);
        }
    
        return new Blob([intArray], {type:mimeType});
    }

    async function generate() {
        console.log('generateWithComfy')
        if (imageGeneration.activeWorkflow.backend !== 'comfyui') {
            console.warn('The selected workflow is not a comfyui workflow');
            return;
        }
        if (imageGeneration.processing) {
            console.warn('Already processing');
            return;
        }
        if (websocket.value?.readyState !== WEBSOCKET_OPEN) {
            console.warn('Websocket not open');
            return;
        }
        try {
            const mutableWorkflow: ComfyUIApiWorkflow = JSON.parse(JSON.stringify(imageGeneration.activeWorkflow.comfyUiApiWorkflow))
            const seed = imageGeneration.seed === -1 ? (Math.random() * 1000000) : imageGeneration.seed;

            modifySettingInWorkflow(mutableWorkflow, 'inferenceSteps', imageGeneration.inferenceSteps);
            modifySettingInWorkflow(mutableWorkflow, 'height', imageGeneration.height);
            modifySettingInWorkflow(mutableWorkflow, 'width', imageGeneration.width);
            modifySettingInWorkflow(mutableWorkflow, 'prompt', imageGeneration.prompt);
            modifySettingInWorkflow(mutableWorkflow, 'negativePrompt', imageGeneration.negativePrompt);

            for (const input of imageGeneration.comfyInputs) {
                const keys = findKeysByTitle(mutableWorkflow, input.nodeTitle);
                if (input.type === 'number') {
                    if (mutableWorkflow[keys[0]].inputs !== undefined) {
                        (mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = input.current.value;
                    }
                }
                if (input.type === 'image') {
                    if (typeof input.current.value !== 'string') continue;
                    const uploadImageHash = Array.from(new Uint8Array(await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.current.value)))).map((b) => b.toString(16).padStart(2, "0")).join("");
                    const uploadImageExtension = input.current.value.match(/data:image\/(png|jpeg|webp);base64,/)?.[1];
                    const uploadImageName = `${uploadImageHash}.${uploadImageExtension}`;
                    console.log('uploadImageName', uploadImageName);
                    if (mutableWorkflow[keys[0]].inputs !== undefined) {
                        (mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = uploadImageName;
                    }
                    const data = new FormData();
                    data.append('image', dataURItoBlob(input.current.value), uploadImageName);
                    await fetch(`http://${comfyHostAndPort.value}/upload/image`, {
                        method: 'POST',
                        body: data
                    });
                }
            }

            loaderNodes.value = [
                ...findKeysByClassType(mutableWorkflow, 'CheckpointLoaderSimple'),
                ...findKeysByClassType(mutableWorkflow, 'Unet Loader (GGUF)'),
                ...findKeysByClassType(mutableWorkflow, 'DualCLIPLoader (GGUF)'),
            ];

            for (let i = 0; i < imageGeneration.batchSize; i++) {
                modifySettingInWorkflow(mutableWorkflow, 'seed', `${(seed + i).toFixed(0)}`);
                
                const result = await fetch(`http://${comfyHostAndPort.value}/prompt`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        prompt: mutableWorkflow,
                        client_id: clientId
                    })
                })
                if (result.status > 299) {
                    throw new Error(`ComfyUI Backend responded with ${result.status}: ${await result.text()}`)
                }
            }
        } catch (ex) {
            console.error('Error generating image', ex);
            toast.error('Backend could not generate image.');
            imageGeneration.processing = false;
            imageGeneration.currentState = "no_start"
        } finally {
        }
    }

    async function stop() {
        await fetch(`http://${comfyHostAndPort.value}/queue`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ clear: true })
        })
        await fetch(`http://${comfyHostAndPort.value}/interrupt`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        })
    }

    async function free() {
        if (!comfyUiState.value) {
            console.debug('ComfyUI backend not running, nothing to free');
            return;
        }
        await fetch(`http://${comfyHostAndPort.value}/free`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ free_memory: true,
                unload_models: true })
        })
        await fetch(`${useGlobalSetup().apiHost}/api/triggerxpucacheclear`, {
            method: "POST"
        })
    }

    return {
        updateComfyState,
        generate,
        stop,
        free
    }
}, {
    persist: {
        pick: ['backend']
    }
});

const settingToComfyInputsName = {
    'seed': ['seed', 'noise_seed'],
    'inferenceSteps': ['steps'],
    'height': ['height'],
    'width': ['width'],
    'prompt': ['text'],
    'negativePrompt': ['text'],
    'guidanceScale': ['cfg'],
    'scheduler': ['scheduler'],
    'batchSize': ['batch_size'],
} satisfies Partial<Record<Setting, string[]>>;
type ComfySetting = keyof typeof settingToComfyInputsName;
const findKeysByTitle = (workflow: ComfyUIApiWorkflow, title: ComfySetting | 'loader' | string) =>
    Object.entries(workflow).filter(([_key, value]) => (value as any)?.['_meta']?.title === title).map(([key, _value]) => key);
const findKeysByClassType = (workflow: ComfyUIApiWorkflow, classType: string) =>
    Object.entries(workflow).filter(([_key, value]) => (value as any)?.['class_type'] === classType).map(([key, _value]) => key);
const findKeysByInputsName = (workflow: ComfyUIApiWorkflow, setting: ComfySetting) => {
    for (const inputName of settingToComfyInputsName[setting]) {
        if (inputName === 'text') continue;
        const keys = Object.entries(workflow).filter(([_key, value]) => (value as any)?.['inputs']?.[inputName ?? ''] !== undefined).map(([key, _value]) => key)
        if (keys.length > 0) return keys;
    }
    return [];
};
const getInputNameBySettingAndKey = (workflow: ComfyUIApiWorkflow, key: string, setting: ComfySetting) => {
    for (const inputName of settingToComfyInputsName[setting]) {
        if (workflow[key]?.inputs?.[inputName ?? '']) return inputName;
    }
    return '';
}
function modifySettingInWorkflow(workflow: ComfyUIApiWorkflow, setting: ComfySetting, value: any) {
    const keys = findKeysByTitle(workflow, setting).length > 0 ? findKeysByTitle(workflow, setting) : findKeysByInputsName(workflow, setting);
    if (keys.length === 0) {
        console.error(`No key found for setting ${setting}. Stopping generation`);
        return;
    }
    if (keys.length > 1) {
        console.warn(`Multiple keys found for setting ${setting}. Using first one`);
    }
    const key = keys[0];
    if (workflow[key]?.inputs?.[getInputNameBySettingAndKey(workflow, key, setting)] !== undefined) {
        workflow[key].inputs[getInputNameBySettingAndKey(workflow, key, setting)] = value;
    }
}

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useComfyUi, import.meta.hot))
}