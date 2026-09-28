$ErrorActionPreference = 'Continue'
$root = 'C:\AI-Playground-schuettm'
Write-Host '=== procs ==='
Get-Process electron,llama-server,ovms,python,ComfyUI -ErrorAction SilentlyContinue |
  Select-Object Name,Id | Format-Table -AutoSize
Write-Host '=== backends installed ==='
foreach ($d in @('LlamaCPP','OpenVINO','ComfyUI','qwen3-tts','whisper-backend')) {
  $p = Join-Path $root $d
  Write-Host ("{0,-20} {1}" -f $d, (Test-Path $p))
}
Write-Host '=== embedding ==='
Get-ChildItem (Join-Path $root 'models\LLM\embedding') -Recurse -Filter *.gguf -ErrorAction SilentlyContinue |
  ForEach-Object { '{0,10:N1} MiB  {1}' -f ($_.Length/1MB), $_.FullName }
Write-Host '=== STT ==='
Get-ChildItem (Join-Path $root 'models\STT') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Name }
Write-Host '=== TTS ==='
Get-ChildItem (Join-Path $root 'models\TTS') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Name }
Get-ChildItem (Join-Path $root 'models\openvino') -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'Qwen3-TTS|Kokoro' } |
  ForEach-Object { $_.Name }
Write-Host '=== Comfy checkpoints/unet (top) ==='
foreach ($sub in @('checkpoints','unet','diffusion_models','clip','vae')) {
  $dir = Join-Path $root "models\ComfyUI\$sub"
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 50MB } |
    Sort-Object Length -Descending |
    Select-Object -First 8 |
    ForEach-Object { '{0,10:N1} MiB  {1}\{2}' -f ($_.Length/1MB), $sub, $_.Name }
}
Write-Host '=== ovms ==='
Get-ChildItem (Join-Path $root 'OpenVINO') -Recurse -Filter ovms.exe -ErrorAction SilentlyContinue |
  Select-Object -First 3 FullName
Write-Host '=== qwen3-tts venv ==='
Test-Path (Join-Path $root 'qwen3-tts\.venv\Scripts\python.exe')
Write-Host '=== comfy python ==='
Test-Path (Join-Path $root 'ComfyUI\.venv\Scripts\python.exe')
Test-Path (Join-Path $root 'ComfyUI\ComfyUI\main.py')
Write-Host '=== disk ==='
Get-PSDrive C | Select-Object Used,Free
