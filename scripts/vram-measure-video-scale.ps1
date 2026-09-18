$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$measure = Join-Path $root 'scripts\vram-measure-process.mts'
$scripts = Join-Path $root 'scripts'
New-Item -ItemType Directory -Force -Path (Join-Path $scripts 'vram-out') | Out-Null
Set-Location $root

function Stop-GpuHogs {
  foreach ($name in @('llama-server','ovms','electron','IntelGraphicsSoftware.Overlay')) {
    Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ComfyUI|web_api.py|main.py' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Invoke-Sweep {
  param([string]$Label, [string]$SweepFile)
  Write-Host "===== $Label ====="
  Stop-GpuHogs
  $comfyDir = Join-Path $root 'ComfyUI'
  $comfyPy = Join-Path $comfyDir '.venv\Scripts\python.exe'
  $comfyVenv = Join-Path $comfyDir '.venv'
  $env:AIPG_LOOPBACK_TOKEN = 'vrammeasure'
  $env:VIRTUAL_ENV = $comfyVenv
  $env:PYTHONNOUSERSITE = '1'
  $env:PYTHONPATH = Join-Path $comfyVenv 'Lib\site-packages'
  $env:PATH = "$(Join-Path $comfyVenv 'Scripts');$(Join-Path $comfyVenv 'Library\bin');$env:PATH"
  $env:ONEAPI_DEVICE_SELECTOR = 'level_zero:*'
  $env:HF_HUB_OFFLINE = '1'
  & node @(
    '--experimental-strip-types', '--no-warnings', $measure,
    '--label', $Label,
    '--health', 'http://127.0.0.1:8188/system_stats',
    '--auth-header', 'Authorization: Bearer vrammeasure',
    '--timeout-ms', '400000',
    '--workflow-timeout-ms', '1200000',
    '--cwd', $comfyDir,
    '--sweep', $SweepFile,
    '--', $comfyPy, 'main.py', '--port', '8188', '--listen', '127.0.0.1',
    '--output-directory', (Join-Path $scripts 'vram-out')
  )
  if ($LASTEXITCODE -ne 0) { throw "measure failed: $Label" }
  Start-Sleep -Seconds 5
}

Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
Invoke-Sweep 'ltx2b-scale' (Join-Path $scripts 'vram-sweep-ltx2b.json')
Invoke-Sweep 'ltx23-scale' (Join-Path $scripts 'vram-sweep-ltx23.json')
Write-Host '===== done ====='
