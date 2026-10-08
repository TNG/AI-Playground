$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$measure = Join-Path $root 'scripts\vram-measure-process.mts'
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

Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
$env:AIPG_LOOPBACK_TOKEN = 'vrammeasure'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:QWEN3_TTS_WARMUP = '0'
$env:QWEN3_TTS_DEVICE = 'xpu'
$env:QWEN3_TTS_ATTN = 'sdpa'
$env:ONEAPI_DEVICE_SELECTOR = 'level_zero:*'
$env:SYCL_ENABLE_DEFAULT_CONTEXTS = '1'
$env:SYCL_CACHE_PERSISTENT = '1'
$tts17 = Join-Path $root 'models\TTS\Qwen---Qwen3-TTS-12Hz-1.7B-VoiceDesign'
$env:QWEN3_TTS_MODEL = $tts17
$ttsPy = 'C:\Users\intel-ptl-user\AppData\Roaming\uv\python\cpython-3.12.13-windows-x86_64-none\python.exe'
$ttsDir = Join-Path $root 'qwen3-tts'
$ttsVenv = Join-Path $ttsDir '.venv'
$env:VIRTUAL_ENV = $ttsVenv
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = Join-Path $ttsVenv 'Lib\site-packages'
$env:PATH = "$(Join-Path $ttsVenv 'Scripts');$(Join-Path $ttsVenv 'Library\bin');$env:PATH"

Write-Host '===== tts-qwen3-1.7b ====='
Stop-GpuHogs
& node --experimental-strip-types --no-warnings $measure `
  --label tts-qwen3-1.7b `
  --health http://127.0.0.1:57001/healthy `
  --timeout-ms 400000 `
  --cwd $ttsDir `
  --probe-url http://127.0.0.1:57001/api/load `
  --probe-body '{"mode":"custom_voice"}' `
  --probe-header 'X-AIPG-Auth:vrammeasure' `
  -- $ttsPy web_api.py --port 57001
if ($LASTEXITCODE -ne 0) { throw 'measure failed: tts-qwen3-1.7b' }
Write-Host '===== done ====='
