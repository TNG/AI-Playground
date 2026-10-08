$ErrorActionPreference = 'Stop'
$py = 'C:\Users\intel-ptl-user\AppData\Roaming\uv\python\cpython-3.12.13-windows-x86_64-none\python.exe'
$venv = 'C:\AI-Playground-schuettm\qwen3-tts\.venv'
$env:VIRTUAL_ENV = $venv
$env:PYTHONNOUSERSITE = '1'
$env:PATH = "$(Join-Path $venv 'Scripts');$(Join-Path $venv 'Library\bin');$env:PATH"
$env:PYTHONPATH = Join-Path $venv 'Lib\site-packages'
& $py -c "import torch; print(torch.__version__); print('xpu', hasattr(torch,'xpu') and torch.xpu.is_available())"
