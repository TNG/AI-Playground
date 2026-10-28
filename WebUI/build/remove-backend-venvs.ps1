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

function Remove-Venv([string]$venv) {
  $item = Get-Item -LiteralPath $venv -Force -ErrorAction SilentlyContinue
  if ($item -and (Test-ReparsePoint $item)) {
    # rd on a link removes the link only, never its target.
    & cmd.exe /d /c rmdir $venv 2>$null | Out-Null
    if (Test-Path -LiteralPath $venv) { return 'it is a link that could not be removed' }
    return $null
  }

  $longPath = Get-LongPath $venv
  & attrib.exe -R /S /D (Join-Path $venv '*') 2>$null | Out-Null
  & cmd.exe /d /c rd /s /q $longPath 2>$null | Out-Null
  if (-not (Test-Path -LiteralPath $venv)) { return $null }
  Start-Sleep -Milliseconds 500

  # The retry, and rd does not say which file stopped it; Remove-Item does.
  $reason = 'the folder could not be removed'
  try {
    Remove-Item -LiteralPath $longPath -Recurse -Force -ErrorAction Stop
  } catch {
    $reason = ($_.Exception.Message -replace '[\r\n\t]+', ' ').Trim()
  }
  if (Test-Path -LiteralPath $venv) { return $reason }
  return $null
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
