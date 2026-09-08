$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$measure = Join-Path $root 'scripts\vram-measure-process.mts'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'scripts\vram-out') | Out-Null
Set-Location $root

function Stop-GpuHogs {
  foreach ($name in @('llama-server','ovms','electron')) {
    Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ComfyUI|web_api.py|main.py' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Invoke-Measure {
  param([string]$Label, [string[]]$NodeArgs)
  Write-Host "===== $Label ====="
  Stop-GpuHogs
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "measure failed: $Label" }
  Start-Sleep -Seconds 5
}

$server = Join-Path $root 'LlamaCPP\llama-cpp\llama-server.exe'
$embed = Join-Path $root 'models\LLM\embedding\llamaCPP\ChristianAzinn---bge-small-en-v1.5-gguf\bge-small-en-v1.5.Q8_0.gguf'
$from = $env:VRAM_FROM
if (-not $from -or $from -eq 'embed') {
Invoke-Measure 'embed-bge-small' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'embed-bge-small',
  '--health', 'http://127.0.0.1:39200/health',
  '--', $server,
  '--embedding', '--model', $embed, '--port', '39200', '--host', '127.0.0.1',
  '--gpu-layers', '999', '--no-mmap', '-fa', 'on', '-b', '1024', '-ub', '1024'
)
}

$ovmsDir = Join-Path $root 'OpenVINO\ovms'
$ovms = Join-Path $ovmsDir 'ovms.exe'
if (-not $from -or $from -eq 'embed' -or $from -eq 'stt') {
$env:OVMS_DIR = $ovmsDir
$env:PYTHONHOME = Join-Path $ovmsDir 'python'
$env:PATH = "$ovmsDir;$(Join-Path $ovmsDir 'python');$(Join-Path $ovmsDir 'python\Scripts');$env:PATH"
Invoke-Measure 'stt-whisper-base-ov' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'stt-whisper-base-ov',
  '--health', 'http://127.0.0.1:29200/v2/health/ready',
  '--timeout-ms', '400000',
  '--cwd', $ovmsDir,
  '--', $ovms,
  '--rest_bind_address', '127.0.0.1', '--rest_port', '29200', '--rest_workers', '1',
  '--source_model', 'OpenVINO---whisper-base-int8-ov',
  '--model_repository_path', (Join-Path $root 'models\STT'),
  '--model_name', 'OpenVINO---whisper-base-int8-ov',
  '--target_device', 'GPU',
  '--task', 'speech2text',
  '--cache_dir', 'cache'
)
}

Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:OVMS_DIR -ErrorAction SilentlyContinue
$env:AIPG_LOOPBACK_TOKEN = 'vrammeasure'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:QWEN3_TTS_DEVICE = 'xpu'
$env:QWEN3_TTS_ATTN = 'sdpa'
$env:ONEAPI_DEVICE_SELECTOR = 'level_zero:*'
$env:SYCL_ENABLE_DEFAULT_CONTEXTS = '1'
$env:SYCL_CACHE_PERSISTENT = '1'
$env:QWEN3_TTS_MODEL = Join-Path $root 'models\TTS\Qwen---Qwen3-TTS-12Hz-0.6B-CustomVoice'
$ttsPy = 'C:\Users\intel-ptl-user\AppData\Roaming\uv\python\cpython-3.12.13-windows-x86_64-none\python.exe'
$ttsDir = Join-Path $root 'qwen3-tts'
$ttsVenv = Join-Path $ttsDir '.venv'
$env:VIRTUAL_ENV = $ttsVenv
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = Join-Path $ttsVenv 'Lib\site-packages'
$env:PATH = "$(Join-Path $ttsVenv 'Scripts');$(Join-Path $ttsVenv 'Library\bin');$env:PATH"
if (-not $from -or $from -eq 'embed' -or $from -eq 'stt' -or $from -eq 'tts') {
Invoke-Measure 'tts-qwen3-0.6b' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'tts-qwen3-0.6b',
  '--health', 'http://127.0.0.1:57001/healthy',
  '--timeout-ms', '400000',
  '--cwd', $ttsDir,
  '--probe-url', 'http://127.0.0.1:57001/api/load',
  '--probe-body', '{"mode":"custom_voice"}',
  '--probe-header', 'X-AIPG-Auth:vrammeasure',
  '--', $ttsPy, 'web_api.py', '--port', '57001'
)
}

$comfyDir = Join-Path $root 'ComfyUI'
$comfyPy = Join-Path $comfyDir '.venv\Scripts\python.exe'
$comfyVenv = Join-Path $comfyDir '.venv'
$env:AIPG_LOOPBACK_TOKEN = 'vrammeasure'
$env:VIRTUAL_ENV = $comfyVenv
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = Join-Path $comfyVenv 'Lib\site-packages'
$env:PATH = "$(Join-Path $comfyVenv 'Scripts');$(Join-Path $comfyVenv 'Library\bin');$env:PATH"
$env:ONEAPI_DEVICE_SELECTOR = 'level_zero:*'
Invoke-Measure 'comfy-sd15-512' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'comfy-sd15-512',
  '--health', 'http://127.0.0.1:8188/system_stats',
  '--auth-header', 'Authorization: Bearer vrammeasure',
  '--timeout-ms', '400000',
  '--cwd', $comfyDir,
  '--comfy-workflow', (Join-Path $root 'scripts\comfy-sd15-512.json'),
  '--', $comfyPy, 'main.py', '--port', '8188', '--listen', '127.0.0.1',
  '--output-directory', (Join-Path $root 'scripts\vram-out')
)

Invoke-Measure 'comfy-sdxl-1024' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'comfy-sdxl-1024',
  '--health', 'http://127.0.0.1:8188/system_stats',
  '--auth-header', 'Authorization: Bearer vrammeasure',
  '--timeout-ms', '400000',
  '--cwd', $comfyDir,
  '--comfy-workflow', (Join-Path $root 'scripts\comfy-sdxl-1024.json'),
  '--', $comfyPy, 'main.py', '--port', '8188', '--listen', '127.0.0.1',
  '--output-directory', (Join-Path $root 'scripts\vram-out')
)

Write-Host '===== done ====='
