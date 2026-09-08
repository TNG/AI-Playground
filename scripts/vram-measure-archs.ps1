$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$server = Join-Path $root 'LlamaCPP\llama-cpp\llama-server.exe'
$script = Join-Path $root 'scripts\vram-measure.mts'
$gguf = Join-Path $root 'models\LLM\ggufLLM'
Set-Location $root

$gemma3 = Join-Path $gguf 'unsloth---gemma-3-4b-it-GGUF\gemma-3-4b-it-Q4_K_M.gguf'
$gemma4 = Join-Path $gguf 'unsloth---gemma-4-E4B-it-GGUF\gemma-4-E4B-it-Q4_K_M.gguf'
$llama = Join-Path $gguf 'bartowski---Meta-Llama-3.1-8B-Instruct-GGUF\Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'
$lfm = Join-Path $gguf 'LiquidAI---LFM2.5-350M-GGUF\LFM2.5-350M-Q4_K_M.gguf'

function Invoke-Measure {
  param(
    [string]$Label,
    [string]$Model,
    [int]$Ctx
  )
  Write-Host "===== $Label ====="
  $args = @(
    '--experimental-strip-types', '--no-warnings', $script,
    '--server', $server,
    '--model', $Model,
    '--ctx', "$Ctx",
    '--label', $Label,
    '--port', '39200'
  )
  & node @args
  if ($LASTEXITCODE -ne 0) { throw "measure failed: $Label" }
  Start-Sleep -Seconds 5
}

Invoke-Measure -Label 'gemma3-4b-8k' -Model $gemma3 -Ctx 8192
Invoke-Measure -Label 'gemma3-4b-32k' -Model $gemma3 -Ctx 32000
Invoke-Measure -Label 'gemma3-4b-128k' -Model $gemma3 -Ctx 131072
Invoke-Measure -Label 'gemma4-e4b-8k' -Model $gemma4 -Ctx 8192
Invoke-Measure -Label 'gemma4-e4b-32k' -Model $gemma4 -Ctx 32000
Invoke-Measure -Label 'gemma4-e4b-128k' -Model $gemma4 -Ctx 131072
Invoke-Measure -Label 'llama31-8b-8k' -Model $llama -Ctx 8192
Invoke-Measure -Label 'llama31-8b-32k' -Model $llama -Ctx 32000
Invoke-Measure -Label 'llama31-8b-128k' -Model $llama -Ctx 131072
Invoke-Measure -Label 'lfm25-350m-8k' -Model $lfm -Ctx 8192
Invoke-Measure -Label 'lfm25-350m-32k' -Model $lfm -Ctx 32000
Invoke-Measure -Label 'lfm25-350m-128k' -Model $lfm -Ctx 131072
Write-Host '===== done ====='
