$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$server = Join-Path $root 'LlamaCPP\llama-cpp\llama-server.exe'
$script = Join-Path $root 'scripts\vram-measure.mts'
$model = Join-Path $root 'models\LLM\ggufLLM\unsloth---Qwen3.8-27B-GGUF\Qwen3.8-27B-UD-Q4_K_XL.gguf'
$mmproj = Join-Path $root 'models\LLM\ggufLLM\unsloth---Qwen3.8-27B-GGUF\mmproj-BF16.gguf'
Set-Location $root

function Invoke-Measure {
  param([string]$Label, [int]$Ctx, [switch]$Mtp)
  Write-Host "===== $Label ====="
  $args = @(
    '--experimental-strip-types', '--no-warnings', $script,
    '--server', $server, '--model', $model, '--mmproj', $mmproj,
    '--ctx', "$Ctx", '--label', $Label, '--port', '39200'
  )
  if ($Mtp) { $args += '--mtp' }
  & node @args
  if ($LASTEXITCODE -ne 0) { throw "measure failed: $Label" }
  Start-Sleep -Seconds 8
}

Invoke-Measure -Label '27b-8k' -Ctx 8192
Invoke-Measure -Label '27b-8k-mtp' -Ctx 8192 -Mtp
Write-Host '===== done ====='
