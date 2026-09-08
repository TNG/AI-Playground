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
  param([string]$Label, [string[]]$NodeArgs, [switch]$AllowFail)
  Write-Host "===== $Label ====="
  Stop-GpuHogs
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) {
    if ($AllowFail) { Write-Host "WARN: $Label failed (continuing)" }
    else { throw "measure failed: $Label" }
  }
  Start-Sleep -Seconds 5
}

Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Remove-Item Env:OVMS_DIR -ErrorAction SilentlyContinue
$env:AIPG_LOOPBACK_TOKEN = 'vrammeasure'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:QWEN3_TTS_WARMUP = '0'
$env:QWEN3_TTS_DEVICE = 'xpu'
$env:QWEN3_TTS_ATTN = 'sdpa'
$env:ONEAPI_DEVICE_SELECTOR = 'level_zero:*'
$env:SYCL_ENABLE_DEFAULT_CONTEXTS = '1'
$env:SYCL_CACHE_PERSISTENT = '1'
$comfyDir = Join-Path $root 'ComfyUI'
$comfyPy = Join-Path $comfyDir '.venv\Scripts\python.exe'
$comfyVenv = Join-Path $comfyDir '.venv'
$env:VIRTUAL_ENV = $comfyVenv
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = Join-Path $comfyVenv 'Lib\site-packages'
$env:PATH = "$(Join-Path $comfyVenv 'Scripts');$(Join-Path $comfyVenv 'Library\bin');$env:PATH"
$env:ONEAPI_DEVICE_SELECTOR = 'level_zero:*'

Invoke-Measure 'comfy-flux-1024' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'comfy-flux-1024',
  '--health', 'http://127.0.0.1:8188/system_stats',
  '--auth-header', 'Authorization: Bearer vrammeasure',
  '--timeout-ms', '400000',
  '--cwd', $comfyDir,
  '--comfy-workflow', (Join-Path $root 'scripts\comfy-flux-1024.json'),
  '--', $comfyPy, 'main.py', '--port', '8188', '--listen', '127.0.0.1',
  '--output-directory', (Join-Path $root 'scripts\vram-out')
)

Invoke-Measure 'comfy-ltx-t2v' @(
  '--experimental-strip-types', '--no-warnings', $measure,
  '--label', 'comfy-ltx-t2v',
  '--health', 'http://127.0.0.1:8188/system_stats',
  '--auth-header', 'Authorization: Bearer vrammeasure',
  '--timeout-ms', '400000',
  '--cwd', $comfyDir,
  '--comfy-workflow', (Join-Path $root 'scripts\comfy-ltx-t2v.json'),
  '--', $comfyPy, 'main.py', '--port', '8188', '--listen', '127.0.0.1',
  '--output-directory', (Join-Path $root 'scripts\vram-out')
)

Write-Host '===== done ====='
