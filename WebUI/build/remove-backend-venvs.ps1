# Removes every backend Python environment (<root>\.venv and <root>\<backend>\.venv) under the
# install roots listed in -RootsFile, one per line. Run by the uninstaller (installer.nsh).
# Prints "Not removed: <path>: <reason>" per leftover and writes the same lines, capped for a
# message box, to -ReportFile.
# Exit codes: 0 all removed, 1 something left behind, 2 bad arguments.
param(
  [Parameter(Mandatory = $true)][string]$RootsFile,
  [Parameter(Mandatory = $true)][string]$ReportFile
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path -LiteralPath $RootsFile -PathType Leaf)) { exit 2 }

function Test-ReparsePoint([System.IO.FileSystemInfo]$item) {
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# RMDir and Remove-Item stop at MAX_PATH; ComfyUI's site-packages goes well past it.
function Get-LongPath([string]$path) {
  if ($path.StartsWith('\\')) { return '\\?\UNC\' + $path.Substring(2) }
  return '\\?\' + $path
}

function Find-BackendVenvs([string]$root) {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() }
  $rootItem = Get-Item -LiteralPath $root -Force
  # A planted link must not redirect an (elevated) delete somewhere else.
  if (Test-ReparsePoint $rootItem) { return @() }
  $dirs = @($rootItem) + @(Get-ChildItem -LiteralPath $rootItem.FullName -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { -not (Test-ReparsePoint $_) })
  return $dirs | ForEach-Object { Join-Path $_.FullName '.venv' } | Where-Object { Test-Path -LiteralPath $_ }
}

# A backend that outlived the app (orphaned python.exe) holds its venv's DLLs open.
function Stop-VenvProcesses([string[]]$venvs) {
  try {
    $running = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath }
  } catch {
    return
  }
  # A process started through an 8.3 path (C:\Users\RUNNER~1\...) reports it as is, while the
  # venv paths are long, so compare long forms.
  foreach ($process in $running) {
    if ($process.ExecutablePath.Contains('~')) {
      $long = (Get-Item -LiteralPath $process.ExecutablePath -Force -ErrorAction SilentlyContinue).FullName
      if ($long) { $process | Add-Member -NotePropertyName ExecutablePath -NotePropertyValue $long -Force }
    }
  }
  $stopped = $false
  foreach ($venv in $venvs) {
    $prefix = $venv.TrimEnd('\') + '\'
    foreach ($process in $running | Where-Object { $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped = $true
    }
  }
  if ($stopped) { Start-Sleep -Milliseconds 500 }
}

$cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'

# Every entry under $dir that is not a link, never descending into one. attrib /S walks into
# junctions, so it would clear read-only bits on whatever a planted link points at.
function Get-TreeEntries([string]$dir) {
  $pending = New-Object System.Collections.Stack
  $pending.Push((New-Object System.IO.DirectoryInfo (Get-LongPath $dir)))
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    try { $entries = @($current.EnumerateFileSystemInfos()) } catch { continue }
    foreach ($entry in $entries) {
      if (Test-ReparsePoint $entry) { continue }
      $entry
      if ($entry -is [System.IO.DirectoryInfo]) { $pending.Push($entry) }
    }
  }
}

function Remove-Venv([string]$venv) {
  $item = Get-Item -LiteralPath $venv -Force -ErrorAction SilentlyContinue
  if ($item -and (Test-ReparsePoint $item)) {
    # rd on a link removes the link only, never its target.
    & $cmd /d /c rmdir $venv 2>$null | Out-Null
    if (Test-Path -LiteralPath $venv) { return 'it is a link that could not be removed' }
    return $null
  }

  # rd /s refuses read-only files but removes links inside the tree without following them.
  foreach ($entry in Get-TreeEntries $venv) {
    if ($entry.Attributes -band [System.IO.FileAttributes]::ReadOnly) {
      try { $entry.Attributes = $entry.Attributes -band -bnot [System.IO.FileAttributes]::ReadOnly } catch {}
    }
  }
  $longPath = Get-LongPath $venv
  foreach ($attempt in 1..2) {
    & $cmd /d /c rd /s /q $longPath 2>$null | Out-Null
    if (-not (Test-Path -LiteralPath $venv)) { return $null }
    Start-Sleep -Milliseconds 500
  }

  # rd does not say what stopped it; what it left behind is what was held open.
  $leftover = Get-TreeEntries $venv | Where-Object { $_ -is [System.IO.FileInfo] } | Select-Object -First 1
  if ($leftover) { return "could not delete $($leftover.FullName -replace '^\\\\\?\\', '')" }
  return 'the folder could not be removed'
}

$roots = Get-Content -LiteralPath $RootsFile | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique
$venvs = @($roots | ForEach-Object { Find-BackendVenvs $_ })
if ($venvs.Count -gt 0) { Stop-VenvProcesses $venvs }

$leftovers = @()
foreach ($venv in $venvs) {
  $reason = Remove-Venv $venv
  if ($reason) {
    $leftovers += "${venv}: $reason"
    Write-Output "Not removed: ${venv}: $reason"
  }
}

# The report is shown in a message box as is, and NSIS strings stop at 1024 characters.
$report = ''
foreach ($line in $leftovers) {
  if ($line.Length -gt 300) { $line = $line.Substring(0, 297) + '...' }
  if ($report.Length + $line.Length -gt 700) {
    $report += "...and more (see the uninstall details)`r`n"
    break
  }
  $report += "$line`r`n"
}
# UTF-16LE without a BOM: the uninstaller reads it back with FileReadUTF16LE (non-ASCII user names).
[System.IO.File]::WriteAllText($ReportFile, $report, (New-Object System.Text.UnicodeEncoding($false, $false)))
if ($leftovers.Count -gt 0) { exit 1 }
exit 0
