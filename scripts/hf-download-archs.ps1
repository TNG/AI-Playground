$ErrorActionPreference = 'Stop'
$root = 'C:\AI-Playground-schuettm'
$venv = Join-Path $root 'tools\hf'
$py = Join-Path $venv 'Scripts\python.exe'
$hf = Join-Path $venv 'Scripts\hf.exe'
$destRoot = Join-Path $root 'models\LLM\ggufLLM'
$sysPy = 'C:\Users\intel-ptl-user\AppData\Local\Programs\Python\Python313\python.exe'

Remove-Item Env:HF_HUB_DISABLE_XET -ErrorAction SilentlyContinue
$env:HF_XET_HIGH_PERFORMANCE = '1'

if (-not (Test-Path $py)) {
  Write-Host '=== creating venv ==='
  if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
  & $sysPy -m venv $venv
}
Write-Host '=== installing huggingface_hub + hf_xet ==='
& $py -m pip install -U huggingface_hub hf_xet

Write-Host '=== xet check ==='
& $py -c "import os, huggingface_hub, hf_xet; from importlib.util import find_spec; print('huggingface_hub', huggingface_hub.__version__); print('hf_xet', getattr(hf_xet, '__version__', 'ok')); print('hf_xet_spec', find_spec('hf_xet') is not None); print('HF_HUB_DISABLE_XET', os.environ.get('HF_HUB_DISABLE_XET')); print('HF_XET_HIGH_PERFORMANCE', os.environ.get('HF_XET_HIGH_PERFORMANCE'))"

$jobs = @(
  @{ Repo = 'unsloth/gemma-3-4b-it-GGUF'; File = 'gemma-3-4b-it-Q4_K_M.gguf'; Dir = 'unsloth---gemma-3-4b-it-GGUF' },
  @{ Repo = 'unsloth/gemma-4-E4B-it-GGUF'; File = 'gemma-4-E4B-it-Q4_K_M.gguf'; Dir = 'unsloth---gemma-4-E4B-it-GGUF' },
  @{ Repo = 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF'; File = 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'; Dir = 'bartowski---Meta-Llama-3.1-8B-Instruct-GGUF' },
  @{ Repo = 'LiquidAI/LFM2.5-350M-GGUF'; File = 'LFM2.5-350M-Q4_K_M.gguf'; Dir = 'LiquidAI---LFM2.5-350M-GGUF' },
  @{ Repo = 'unsloth/gpt-oss-20b-GGUF'; File = 'gpt-oss-20b-Q8_0.gguf'; Dir = 'unsloth---gpt-oss-20b-GGUF' }
)

foreach ($job in $jobs) {
  $dir = Join-Path $destRoot $job.Dir
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $out = Join-Path $dir $job.File
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 1MB)) {
    Write-Host ("=== skip exists {0} ({1:N1} MiB) ===" -f $job.File, ((Get-Item $out).Length / 1MB))
    continue
  }
  Write-Host ("=== download {0}/{1} ===" -f $job.Repo, $job.File)
  & $hf download $job.Repo $job.File --local-dir $dir
  if ($LASTEXITCODE -ne 0) { throw "hf download failed: $($job.Repo)/$($job.File)" }
}

Write-Host '=== done ==='
Get-ChildItem -Recurse $destRoot -Filter *.gguf |
  Where-Object { $_.Directory.Name -match 'gemma-3-4b|gemma-4-E4B|Llama-3.1-8B|LFM2.5|gpt-oss-20b' } |
  ForEach-Object { '{0,10:N1} MiB  {1}' -f ($_.Length / 1MB), $_.FullName }
