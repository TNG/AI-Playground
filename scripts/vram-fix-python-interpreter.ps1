$ErrorActionPreference = 'Stop'
$linkParent = 'C:\AI-Playground-schuettm\python-interpreter'
$link = Join-Path $linkParent 'cpython-3.12-windows-x86_64-none'
$target = 'C:\Users\intel-ptl-user\AppData\Roaming\uv\python\cpython-3.12.13-windows-x86_64-none'
if (-not (Test-Path $target\python.exe)) { throw "missing $target\python.exe" }
New-Item -ItemType Directory -Force -Path $linkParent | Out-Null
if (Test-Path $link) {
  Write-Host "already exists $link"
} else {
  cmd /c mklink /J "$link" "$target"
}
& 'C:\AI-Playground-schuettm\ComfyUI\.venv\Scripts\python.exe' -c "print('comfy python ok')"
