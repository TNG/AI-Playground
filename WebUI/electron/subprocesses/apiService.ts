import {ChildProcess} from "node:child_process";
import path from "node:path";
import {app, BrowserWindow} from "electron";
import {appLoggerInstance} from "../logging/logger.ts";
import fs from "fs";
import {copyFileWithDirs, existingFileOrError, spawnProcessAsync} from "./osProcessHelper.ts";
import * as filesystem from "fs-extra";
import {z} from "zod";
import {getArchPriority, getDeviceArch} from "./deviceArch.ts";

export const aiBackendServiceDir = () => path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));

const LsLevelZeroDeviceSchema = z.object({id: z.number(), name: z.string(), device_id: z.number()});
const LsLevelZeroOutSchema = z.array(LsLevelZeroDeviceSchema).min(1);
type LsLevelZeroDevice = z.infer<typeof LsLevelZeroDeviceSchema>;

export function getLsLevelZeroPath(basePythonEnvDir: string): string {
    return path.resolve(path.join(basePythonEnvDir, "Library/bin/ls_level_zero.exe"));
}
export function getPythonPath(basePythonEnvDir: string): string {
    return path.resolve(path.join(basePythonEnvDir, "python.exe"))
}

const ipexWheel = "intel_extension_for_pytorch-2.3.110+xpu-cp311-cp311-win_amd64.whl"
export const ipexIndex = 'https://pytorch-extension.intel.com/release-whl/stable/xpu/cn/'
export const ipexVersion = 'intel-extension-for-pytorch==2.3.110.post0+xpu'

export interface ApiService {
    readonly name: string
    readonly baseUrl: string
    readonly port: number
    readonly isRequired: boolean
    currentStatus: BackendStatus;
    isSetUp: boolean;

    set_up(): AsyncIterable<SetupProgress>;
    start(): Promise<BackendStatus>;
    stop(): Promise<BackendStatus>;
    get_info(): ApiServiceInformation;
}

export abstract class LongLivedPythonApiService implements ApiService {
    readonly name: BackendServiceName
    readonly baseUrl: string
    readonly port: number
    readonly win: BrowserWindow
    readonly settings: LocalSettings
    abstract readonly isRequired: boolean
    abstract healthEndpointUrl: string

    encapsulatedProcess: ChildProcess | null = null

    readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
    readonly prototypicalPythonEnv = path.join(this.baseDir, "prototype-python-env")
    readonly customIntelExtensionForPytorch = path.join(app.isPackaged ? this.baseDir : path.join(__dirname, "../../external/"), ipexWheel)
    abstract readonly pythonEnvDir: string
    abstract readonly lsLevelZeroDir: string
    abstract readonly serviceDir: string
    abstract readonly pythonExe: string
    abstract isSetUp: boolean;

    desiredStatus: BackendStatus = "uninitializedStatus"
    currentStatus: BackendStatus = "uninitializedStatus"

    readonly appLogger = appLoggerInstance

    constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
        this.win = win
        this.name = name
        this.port = port
        this.baseUrl = `http://127.0.0.1:${port}`
        this.settings = settings
    }

    abstract serviceIsSetUp(): boolean

    setStatus(status: BackendStatus) {
        this.currentStatus = status
        this.updateStatus()
    }

    updateStatus() {
        this.isSetUp = this.serviceIsSetUp();
        this.win.webContents.send("serviceInfoUpdate", this.get_info());
    }

    get_info(): ApiServiceInformation {
        if(this.currentStatus === "uninitializedStatus") {
            this.currentStatus = this.isSetUp ? "notYetStarted" : "notInstalled"
        }
        return {
            serviceName: this.name,
            status: this.currentStatus,
            baseUrl: this.baseUrl,
            port: this.port,
            isSetUp: this.isSetUp,
            isRequired: this.isRequired
        }
    }

    abstract set_up(): AsyncIterable<SetupProgress>

    async start(): Promise<BackendStatus> {
        if (this.desiredStatus === "stopped" && this.currentStatus !== "stopped") {
            throw new Error('Server currently stopping. Cannot start it.')
        }
        if (this.currentStatus === "running") {
            return "running"
        }
        if (this.desiredStatus === "running") {
            throw new Error('Server startup already requested')
        }

        this.desiredStatus = "running"
        this.setStatus('starting')
        try {
            this.appLogger.info(` trying to start ${this.name} python API`, this.name)
            const trackedProcess = await this.spawnAPIProcess()
            this.encapsulatedProcess = trackedProcess.process
            this.pipeProcessLogs(trackedProcess.process)
            if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
                this.currentStatus = "running"
                this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
            } else {
                this.currentStatus = "failed"
                this.desiredStatus = "failed"
                this.appLogger.error(`server ${this.name} failed to boot`, this.name)
                this.encapsulatedProcess?.kill()
            }
        } catch (error) {
            this.appLogger.error(` failed to start server due to ${error}`, this.name)
            this.currentStatus = "failed"
            this.desiredStatus = "failed"
            this.encapsulatedProcess?.kill()
            this.encapsulatedProcess = null
            throw error;
        } finally {
            this.win.webContents.send("serviceInfoUpdate", this.get_info());
        }
        return this.currentStatus;
    }


    async stop(): Promise<BackendStatus> {
        this.appLogger.info(`Stopping backend ${this.name}. It was in state ${this.currentStatus}`, this.name)
        this.desiredStatus = "stopped"
        this.setStatus('stopping')
        this.encapsulatedProcess?.kill()
        await new Promise(resolve => {
            setTimeout(() => {
                resolve("killedprocess (hopefully)")
            }, 1000)
        })

        this.encapsulatedProcess = null
        this.currentStatus = "stopped"
        return "stopped"
    }

    abstract spawnAPIProcess(): Promise<{ process: ChildProcess; didProcessExitEarlyTracker: Promise<boolean>; }>

    pipeProcessLogs(process: ChildProcess) {
        process.stdout!.on('data', (message) => {
            if (message.toString().startsWith('INFO')) {
                this.appLogger.info(`${message}`, this.name)
            } else if (message.toString().startsWith('WARN')) {
                this.appLogger.warn(`${message}`, this.name)
            } else {
                this.appLogger.error(`${message}`, this.name)
            }
        })

        process.stderr!.on('data', (message) => {
            this.appLogger.error(`${message}`, this.name)
        })
        process.on('error', (message) => {
            this.appLogger.error(`backend process ${this.name} exited abruptly due to : ${message}`, this.name)
        })
    }


    async listenServerReady(didProcessExitEarlyTracker: Promise<boolean>): Promise<boolean> {
        const startTime = performance.now()
        const processStartupCompletePromise = new Promise<boolean>(async (resolve) => {
            const queryIntervalMs = 250
            const startupPeriodMaxMs = 120000
            while (performance.now() < startTime + startupPeriodMaxMs) {
                try {
                    const serviceHealthResponse = await fetch(this.healthEndpointUrl);
                    this.appLogger.info(`received response: ${serviceHealthResponse.status}`, this.name)
                    if (serviceHealthResponse.status === 200) {
                        const endTime = performance.now()
                        this.appLogger.info(`${this.name} server startup complete after ${(endTime - startTime) / 1000} seconds`, this.name)
                        resolve(true)
                        break
                    }
                } catch (e) {
                    //fetch will simply fail while server not up
                }
                await new Promise<void>(resolve => setTimeout(resolve, queryIntervalMs));
            }
            if (performance.now() >= startTime + startupPeriodMaxMs) {
                this.appLogger.warn(`Server ${this.name} did not return healthy response within ${startupPeriodMaxMs / 1000} seconds`, this.name)
                resolve(false)
            }
        })

        const processStartupFailedDueToEarlyExit = didProcessExitEarlyTracker.then(earlyExit => !earlyExit)

        return await Promise.race([processStartupFailedDueToEarlyExit, processStartupCompletePromise])
    }

    private allLevelZeroDevices: {id: number, name: string, device_id: number}[] = []
    private selectedDeviceId: number = -1

    async getAllLevelZeroDevices(envDir: string): Promise<LsLevelZeroDevice[]> {
        console.log('ls level zero executed in', envDir)
        const lsLevelZeroOut = await spawnProcessAsync(getLsLevelZeroPath(envDir), [], (data: string) => {this.appLogger.logMessageToFile(data, this.name)}, {
            ONEAPI_DEVICE_SELECTOR: "level_zero:*" // reset selector env to guarantee full device list (and the ordering)
        });
        this.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, this.name)
        return LsLevelZeroOutSchema.parse(JSON.parse(lsLevelZeroOut));
    }

    selectBestLevelZeroDevice(): void {
        let priority = -1;
        let arch = "unknown";
        for (const device of this.allLevelZeroDevices) {
            arch = getDeviceArch(device.device_id);
            if (arch == "unknown") {
                continue;
            }
            const newPriority = getArchPriority(arch);
            if (newPriority > priority) {
                this.selectedDeviceId = device.id;
                priority = newPriority;
            }
        }
        const selectedDevice = this.allLevelZeroDevices[this.selectedDeviceId];
        this.appLogger.info(`Selected device #${selectedDevice.id}: ${selectedDevice.name} with device_id: 0x${selectedDevice.device_id.toString(16)}, arch: ${arch}`, this.name)
    }

    protected commonSetupSteps = {

        detectDeviceArcMock: async (pythonEnvContainmentDir: string): Promise<string> => {
            this.appLogger.info("Detecting intel deviceID", this.name)
            this.appLogger.info("Copying ls_level_zero.exe", this.name)
            const lsLevelZeroBinaryTargetPath = getLsLevelZeroPath(pythonEnvContainmentDir)
            const src = existingFileOrError(path.resolve(path.join(aiBackendServiceDir(), "tools/ls_level_zero.exe")));
            await copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

            return 'arc';
        },

        detectDevice: async (pythonEnvContainmentDir: string): Promise<string> => {
            try {
                if (this.selectedDeviceId === -1) {
                    this.appLogger.info("Detecting intel deviceID", this.name)
                    // copy ls_level_zero.exe from service/tools to env/Library/bin for SYCL environment
                    this.appLogger.info("Copying ls_level_zero.exe", this.name)
                    const lsLevelZeroBinaryTargetPath = getLsLevelZeroPath(pythonEnvContainmentDir)
                    const src = existingFileOrError(path.resolve(path.join(aiBackendServiceDir(), "tools/ls_level_zero.exe")));
                    await copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

                    this.appLogger.info("Fetching requirements for ls_level_zero.exe", this.name)
                    const pythonExe = existingFileOrError(getPythonPath(pythonEnvContainmentDir))
                    const lsLevelZeroRequirements = existingFileOrError(path.resolve(path.join(aiBackendServiceDir(), "requirements-ls_level_zero.txt")));
                    await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", "-r", lsLevelZeroRequirements], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                    this.allLevelZeroDevices = await this.getAllLevelZeroDevices(pythonEnvContainmentDir);
                    this.selectBestLevelZeroDevice();
                }
                const selectedDevice = this.allLevelZeroDevices[this.selectedDeviceId];
                return getDeviceArch(selectedDevice.device_id);
            } catch (e) {
                this.appLogger.error(`Failure to identify intel hardware. Error: ${e}`, this.name, true);
                throw new Error(`Failure to identify intel hardware. Error: ${e}`);
            }
        },

        getDeviceSelectorEnv: async () => {
            if (this.selectedDeviceId === -1) {
                this.allLevelZeroDevices = await this.getAllLevelZeroDevices(this.lsLevelZeroDir);
                this.selectBestLevelZeroDevice();
            }
            this.appLogger.info(`Setting device selector to level_zero:${this.selectedDeviceId}`, this.name)
            return { ONEAPI_DEVICE_SELECTOR: `level_zero:${this.selectedDeviceId}` }
        },

        copyArchetypePythonEnv: async (targetDir: string) => {
            const archtypePythonEnv = existingFileOrError(this.prototypicalPythonEnv)
            this.appLogger.info(`Cloning archetype python env ${archtypePythonEnv} into ${targetDir}`, this.name, true)
            try {
                if (filesystem.existsSync(targetDir)) {
                    this.appLogger.info(`Cleaning up previously containment directory at ${targetDir}`, this.name, true)
                    await fs.promises.rm(targetDir, {recursive: true, force: true})
                }
                await copyFileWithDirs(archtypePythonEnv, targetDir)
                return targetDir;
            } catch (e) {
                this.appLogger.error(`Failure during set up of workspace. Error: ${e}`, this.name, true)
                throw new Error(`Failure during set up of workspace. Error: ${e}`)
            }
        },

        installUv: async (pythonEnvDir: string) => {
            this.appLogger.info(`installing uv into env ${pythonEnvDir}`, this.name, true)
            try {
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                const getPipScript = existingFileOrError(path.join(pythonEnvDir, 'get-pip.py'))
                await spawnProcessAsync(pythonExe, [getPipScript], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                await spawnProcessAsync(pythonExe, ["-m", "pip", "install", "uv"], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed uv into env ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failed to install uv for env ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install uv. Error: ${e}`);
            }
        },

        uvPipInstallRequirementsTxtStep: async (pythonEnvDir: string, requirementsTextPath: string, {skipOnMissingRequirementsTxt = false, disableUv = false} = {}) => {
            if (skipOnMissingRequirementsTxt && !fs.existsSync(requirementsTextPath)) {
                this.appLogger.info(`No requirements.txt for ${requirementsTextPath} - skipping`, this.name, true)
                return
            }
            try {
                const commands = disableUv ? ["-m", "pip", "install", "-r", requirementsTextPath] : ["-m", "uv", "pip", "install", "-r", requirementsTextPath, "--index-strategy", "unsafe-best-match"];
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                this.appLogger.info(`Installing python dependencies for ${pythonEnvDir}`, this.name, true)
                await spawnProcessAsync(pythonExe, commands, (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed python dependencies for ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure during installation of python dependencies for ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install python dependencies for ${pythonEnvDir}. Error: ${e}`)
            }
        },

        uvInstallDependencyStep: async (pythonEnvDir: string, dependency: string, extraIndex?: string) => {
            try {
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                this.appLogger.info(`Installing dependency ${dependency} for ${pythonEnvDir}`, this.name, true)
                const extraIndexArgs = extraIndex ? ["--extra-index-url", extraIndex] : []
                await spawnProcessAsync(pythonExe, ["-m", "pip", "install", dependency, ...extraIndexArgs], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed of dependency ${dependency} for ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure during installation of dependency ${dependency} for ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install of dependency ${dependency} for ${pythonEnvDir}. Error: ${e}`)
            }
        },

        moveToFinalTarget: async (src: string, target: string) => {
            this.appLogger.info(`renaming directory ${src} to ${target}`, this.name, true)
            try {
                if (filesystem.existsSync(target)) {
                    this.appLogger.info(`Cleaning up previously resource directory at ${target}`, this.name, true)
                    await fs.promises.rm(target, {recursive: true, force: true})
                }
                await filesystem.move(src, target)
                this.appLogger.info(`resources now available at ${target}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure to rename ${src} to ${target}. Error: ${e}`, this.name, true)
                throw new Error(`Failure to rename ${src} to ${target}. Error: ${e}`)
            }
        },
    };
}
