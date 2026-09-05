$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$server = Join-Path $root 'LlamaCPP\llama-cpp\llama-server.exe'
$script = Join-Path $root 'scripts\vram-measure.mts'
$gguf = Join-Path $root 'models\LLM\ggufLLM'
Set-Location $root

$gptoss = Join-Path $gguf 'unsloth---gpt-oss-20b-GGUF\gpt-oss-20b-Q8_0.gguf'
$gemma3 = Join-Path $gguf 'unsloth---gemma-3-4b-it-GGUF\gemma-3-4b-it-Q4_K_M.gguf'
$lfm = Join-Path $gguf 'LiquidAI---LFM2.5-350M-GGUF\LFM2.5-350M-Q4_K_M.gguf'
$mmtp = Join-Path $gguf 'unsloth---Qwen3.5-9B-MTP-GGUF\Qwen3.5-9B-UD-Q4_K_XL.gguf'
$pmtp = Join-Path $gguf 'unsloth---Qwen3.5-9B-MTP-GGUF\mmproj-BF16.gguf'

function Invoke-Measure {
  param(
    [string]$Label,
    [string]$Model,
    [int]$Ctx,
    [string]$Mmproj = '',
    [switch]$Mtp
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
  if ($Mmproj) { $args += '--mmproj', $Mmproj }
  if ($Mtp) { $args += '--mtp' }
  & node @args
  if ($LASTEXITCODE -ne 0) { throw "measure failed: $Label" }
  Start-Sleep -Seconds 5
}

Invoke-Measure -Label 'gptoss-20b-8k' -Model $gptoss -Ctx 8192
Invoke-Measure -Label 'gptoss-20b-32k' -Model $gptoss -Ctx 32000
Invoke-Measure -Label 'gemma3-4b-8k' -Model $gemma3 -Ctx 8192
Invoke-Measure -Label 'gemma3-4b-32k' -Model $gemma3 -Ctx 32000
Invoke-Measure -Label 'gemma3-4b-128k' -Model $gemma3 -Ctx 131072
Invoke-Measure -Label 'lfm25-350m-8k' -Model $lfm -Ctx 8192
Invoke-Measure -Label 'lfm25-350m-32k' -Model $lfm -Ctx 32000
Invoke-Measure -Label 'lfm25-350m-128k' -Model $lfm -Ctx 131072
Invoke-Measure -Label '9b-mtp-32k-spec' -Model $mmtp -Mmproj $pmtp -Ctx 32000 -Mtp
Write-Host '===== done ====='
