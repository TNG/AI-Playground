$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$server = Join-Path $root 'LlamaCPP\llama-cpp\llama-server.exe'
$script = Join-Path $root 'scripts\vram-measure.mts'
$m9 = Join-Path $root 'models\LLM\ggufLLM\unsloth---Qwen3.5-9B-GGUF\Qwen3.5-9B-Q4_K_M.gguf'
$p9 = Join-Path $root 'models\LLM\ggufLLM\unsloth---Qwen3.5-9B-GGUF\mmproj-BF16.gguf'
$mmtp = Join-Path $root 'models\LLM\ggufLLM\unsloth---Qwen3.5-9B-MTP-GGUF\Qwen3.5-9B-UD-Q4_K_XL.gguf'
$pmtp = Join-Path $root 'models\LLM\ggufLLM\unsloth---Qwen3.5-9B-MTP-GGUF\mmproj-BF16.gguf'

Set-Location $root

function Invoke-Measure {
  param(
    [string]$Label,
    [string]$Model,
    [string]$Mmproj,
    [int]$Ctx,
    [switch]$Mtp
  )
  Write-Host "===== $Label ====="
  $args = @(
    '--experimental-strip-types', '--no-warnings', $script,
    '--server', $server,
    '--model', $Model,
    '--mmproj', $Mmproj,
    '--ctx', "$Ctx",
    '--label', $Label,
    '--port', '39200'
  )
  if ($Mtp) { $args += '--mtp' }
  & node @args
  if ($LASTEXITCODE -ne 0) { throw "measure failed: $Label" }
  Start-Sleep -Seconds 5
}

Invoke-Measure -Label '9b-q4-8k' -Model $m9 -Mmproj $p9 -Ctx 8192
Invoke-Measure -Label '9b-q4-32k' -Model $m9 -Mmproj $p9 -Ctx 32000
Invoke-Measure -Label '9b-q4-128k' -Model $m9 -Mmproj $p9 -Ctx 131072
Invoke-Measure -Label '9b-mtp-32k' -Model $mmtp -Mmproj $pmtp -Ctx 32000
Invoke-Measure -Label '9b-mtp-32k-spec' -Model $mmtp -Mmproj $pmtp -Ctx 32000 -Mtp
Write-Host '===== done ====='
