# Reads and writes the Demo Mode keys of settings.json for the Windows installer.
# No ConvertFrom-Json/ConvertTo-Json: Windows PowerShell 5.1 re-indents, escapes and truncates JSON.
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Operation,
  [string]$Path,
  [string]$Enabled,
  [string]$ResetMinutes = '',
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'

$Defaults = @{ Enabled = '1'; Passcode = '0451'; ResetMinutes = '5' }
$MaxResetMinutes = 999999

function Stop-WithUsage([string]$Message) {
  Write-Output $Message
  exit 2
}

function New-JsonNumber([string]$Text) {
  New-Object PSObject -Property @{ JsonNumber = $Text }
}

$script:Json = ''
$script:At = 0
$script:NumberPattern = [regex]'\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'

function Get-JsonChar {
  if ($script:At -ge $script:Json.Length) { return [char]0 }
  return $script:Json[$script:At]
}

function Skip-JsonWhitespace {
  while ($script:At -lt $script:Json.Length -and " `t`r`n".IndexOf($script:Json[$script:At]) -ge 0) {
    $script:At++
  }
}

function Test-JsonLiteral([string]$Word) {
  return ($script:At + $Word.Length -le $script:Json.Length) -and
    ($script:Json.Substring($script:At, $Word.Length) -ceq $Word)
}

function Read-JsonString {
  $script:At++
  $sb = New-Object System.Text.StringBuilder
  while ($true) {
    if ($script:At -ge $script:Json.Length) { throw 'Unterminated string in settings.json' }
    $code = [int]$script:Json[$script:At]
    $script:At++
    if ($code -eq 34) { return $sb.ToString() }
    if ($code -ne 92) {
      [void]$sb.Append([char]$code)
      continue
    }
    $escape = [string](Get-JsonChar)
    $script:At++
    if ($escape -ceq '"') { [void]$sb.Append('"') }
    elseif ($escape -ceq '\') { [void]$sb.Append('\') }
    elseif ($escape -ceq '/') { [void]$sb.Append('/') }
    elseif ($escape -ceq 'b') { [void]$sb.Append([char]8) }
    elseif ($escape -ceq 'f') { [void]$sb.Append([char]12) }
    elseif ($escape -ceq 'n') { [void]$sb.Append([char]10) }
    elseif ($escape -ceq 'r') { [void]$sb.Append([char]13) }
    elseif ($escape -ceq 't') { [void]$sb.Append([char]9) }
    elseif ($escape -ceq 'u' -and $script:At + 4 -le $script:Json.Length) {
      [void]$sb.Append([char][Convert]::ToInt32($script:Json.Substring($script:At, 4), 16))
      $script:At += 4
    }
    else { throw "Invalid escape in settings.json at offset $script:At" }
  }
}

function Read-JsonValue {
  Skip-JsonWhitespace
  $c = [string](Get-JsonChar)
  if ($c -ceq '{') {
    $script:At++
    $object = New-Object System.Collections.Specialized.OrderedDictionary
    Skip-JsonWhitespace
    if ([string](Get-JsonChar) -ceq '}') {
      $script:At++
      return $object
    }
    while ($true) {
      Skip-JsonWhitespace
      if ([string](Get-JsonChar) -cne '"') { throw "Expected a key in settings.json at offset $script:At" }
      $key = Read-JsonString
      Skip-JsonWhitespace
      if ([string](Get-JsonChar) -cne ':') { throw "Expected ':' in settings.json at offset $script:At" }
      $script:At++
      $object[$key] = Read-JsonValue
      Skip-JsonWhitespace
      $next = [string](Get-JsonChar)
      $script:At++
      if ($next -ceq '}') { return $object }
      if ($next -cne ',') { throw "Expected ',' or '}' in settings.json at offset $script:At" }
    }
  }
  if ($c -ceq '[') {
    $script:At++
    $list = New-Object System.Collections.ArrayList
    Skip-JsonWhitespace
    if ([string](Get-JsonChar) -ceq ']') {
      $script:At++
      return , $list
    }
    while ($true) {
      [void]$list.Add((Read-JsonValue))
      Skip-JsonWhitespace
      $next = [string](Get-JsonChar)
      $script:At++
      if ($next -ceq ']') { return , $list }
      if ($next -cne ',') { throw "Expected ',' or ']' in settings.json at offset $script:At" }
    }
  }
  if ($c -ceq '"') { return (Read-JsonString) }
  if (Test-JsonLiteral 'true') { $script:At += 4; return $true }
  if (Test-JsonLiteral 'false') { $script:At += 5; return $false }
  if (Test-JsonLiteral 'null') { $script:At += 4; return $null }
  $number = $script:NumberPattern.Match($script:Json, $script:At)
  if ($number.Success -and $number.Length -gt 0) {
    $script:At += $number.Length
    return (New-JsonNumber $number.Value)
  }
  throw "Unexpected content in settings.json at offset $script:At"
}

function ConvertFrom-JsonText([string]$Text) {
  $script:Json = $Text
  $script:At = 0
  $value = Read-JsonValue
  Skip-JsonWhitespace
  if ($script:At -lt $script:Json.Length) { throw "Unexpected content in settings.json at offset $script:At" }
  if (-not ($value -is [System.Collections.IDictionary])) { throw 'settings.json is not a JSON object' }
  return $value
}

# Escapes the way JavaScript's JSON.stringify does, so the app's own rewrites produce no diff.
function ConvertTo-JsonString([string]$Text) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    if ($code -eq 34) { [void]$sb.Append('\"') }
    elseif ($code -eq 92) { [void]$sb.Append('\\') }
    elseif ($code -eq 8) { [void]$sb.Append('\b') }
    elseif ($code -eq 9) { [void]$sb.Append('\t') }
    elseif ($code -eq 10) { [void]$sb.Append('\n') }
    elseif ($code -eq 12) { [void]$sb.Append('\f') }
    elseif ($code -eq 13) { [void]$sb.Append('\r') }
    elseif ($code -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

# Same layout as JSON.stringify(value, null, 2).
function ConvertTo-JsonText($Value, [string]$Indent) {
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) {
    if ($Value) { return 'true' }
    return 'false'
  }
  if ($Value -is [string]) { return (ConvertTo-JsonString $Value) }
  $inner = $Indent + '  '
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.get_Count() -eq 0) { return '{}' }
    $parts = New-Object System.Collections.ArrayList
    foreach ($key in @($Value.get_Keys())) {
      [void]$parts.Add($inner + (ConvertTo-JsonString $key) + ': ' + (ConvertTo-JsonText ($Value[$key]) $inner))
    }
    return "{`n" + ($parts.ToArray() -join ",`n") + "`n$Indent}"
  }
  if ($Value -is [System.Collections.IList]) {
    if ($Value.get_Count() -eq 0) { return '[]' }
    $parts = New-Object System.Collections.ArrayList
    foreach ($item in $Value) {
      [void]$parts.Add($inner + (ConvertTo-JsonText $item $inner))
    }
    return "[`n" + ($parts.ToArray() -join ",`n") + "`n$Indent]"
  }
  if ($Value.PSObject.Properties['JsonNumber']) { return $Value.JsonNumber }
  throw "Cannot write a value of type $($Value.GetType().FullName) to settings.json"
}

function Write-DemoModeSettings([string]$File, [bool]$IsEnabled, [string]$DemoPasscode, $ResetInSeconds) {
  $settings = New-Object System.Collections.Specialized.OrderedDictionary
  $trailingNewline = "`n"
  if ([System.IO.File]::Exists($File)) {
    $existing = [System.IO.File]::ReadAllText($File)
    $settings = ConvertFrom-JsonText $existing
    if (-not $existing.EndsWith("`n")) { $trailingNewline = '' }
  }
  $settings['isDemoModeEnabled'] = $IsEnabled
  $settings['demoModePasscode'] = $DemoPasscode
  if ($null -eq $ResetInSeconds) {
    $settings['demoModeResetInSeconds'] = $null
  }
  else {
    $settings['demoModeResetInSeconds'] = New-JsonNumber ([string]$ResetInSeconds)
  }
  $text = (ConvertTo-JsonText $settings '') + $trailingNewline
  [System.IO.File]::WriteAllText($File, $text, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
}

function Test-Passcode($Value) {
  return ($Value -is [string]) -and ($Value -ne '') -and
    ($Value.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -lt 0)
}

function Test-ResetMinutes([string]$Text) {
  return ($Text -cmatch '^[0-9]{1,18}\z') -and ([long]$Text -le $MaxResetMinutes)
}

function Read-DemoModeSettings([string]$File) {
  $values = $Defaults.Clone()
  try {
    if (-not $File -or -not [System.IO.File]::Exists($File)) { return $values }
    $settings = ConvertFrom-JsonText ([System.IO.File]::ReadAllText($File))
  }
  catch {
    return $values
  }
  # Releases before the installer's Demo Mode page shipped isDemoModeEnabled: false and no passcode.
  if (-not $settings.Contains('demoModePasscode')) { return $values }
  if ($settings.Contains('isDemoModeEnabled') -and $settings['isDemoModeEnabled'] -is [bool]) {
    if ($settings['isDemoModeEnabled']) { $values.Enabled = '1' } else { $values.Enabled = '0' }
  }
  if (Test-Passcode $settings['demoModePasscode']) {
    $values.Passcode = $settings['demoModePasscode']
  }
  if ($settings.Contains('demoModeResetInSeconds')) {
    $seconds = $settings['demoModeResetInSeconds']
    if ($null -eq $seconds) {
      $values.ResetMinutes = ''
    }
    elseif ($seconds.PSObject.Properties['JsonNumber']) {
      $invariant = [System.Globalization.CultureInfo]::InvariantCulture
      $number = 0.0
      $style = [System.Globalization.NumberStyles]::Float
      if ([double]::TryParse($seconds.JsonNumber, $style, $invariant, [ref]$number) -and
        $number -gt 0 -and -not [double]::IsInfinity($number)) {
        $minutes = [Math]::Min([Math]::Ceiling($number / 60), $MaxResetMinutes)
        $values.ResetMinutes = ([long]$minutes).ToString($invariant)
      }
    }
  }
  return $values
}

function Resolve-FilePath([string]$Value) {
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
}

if ($Operation -eq 'read') {
  if (-not $ResultPath) { Stop-WithUsage 'Missing -ResultPath' }
}
elseif ($Operation -eq 'write') {
  if (-not $Path) { Stop-WithUsage 'Missing -Path' }
  if ($Enabled -cne '1' -and $Enabled -cne '0') { Stop-WithUsage "-Enabled must be 1 or 0, got '$Enabled'" }
  if ($ResetMinutes -ne '' -and -not (Test-ResetMinutes $ResetMinutes)) {
    Stop-WithUsage "-ResetMinutes must be whole minutes up to $MaxResetMinutes, got '$ResetMinutes'"
  }
  # From the environment, not argv: a command line mangles quotes, a leading '-' and non-ASCII.
  $passcode = [string]$env:AIPG_DEMO_PASSCODE
  if ($passcode -eq '') {
    if ($Enabled -ceq '1') { Stop-WithUsage 'AIPG_DEMO_PASSCODE must not be empty while Demo Mode is on' }
    $passcode = $Defaults.Passcode
  }
}
else {
  Stop-WithUsage "Unknown operation '$Operation'. Expected: read or write"
}

try {
  if ($Operation -eq 'read') {
    $file = ''
    if ($Path) { $file = Resolve-FilePath $Path }
    $values = Read-DemoModeSettings $file
    # The raw /DEMORESET parameter, from the environment for the same reason as the passcode.
    $resetParameter = $env:AIPG_DEMO_RESET
    if ($null -ne $resetParameter) {
      if ($resetParameter -eq '') { $values.ResetMinutes = '' }
      elseif (-not (Test-ResetMinutes $resetParameter)) { $values.ResetMinutes = $Defaults.ResetMinutes }
      elseif ([long]$resetParameter -eq 0) { $values.ResetMinutes = '' }
      else { $values.ResetMinutes = ([long]$resetParameter).ToString() }
    }
    # UTF-16LE without a BOM for NSIS's FileReadUTF16LE; stdout would pass the OEM codepage.
    $text = $values.Enabled + "`r`n" + $values.ResetMinutes + "`r`n" + $values.Passcode + "`r`n"
    $encoding = New-Object System.Text.UnicodeEncoding -ArgumentList $false, $false
    [System.IO.File]::WriteAllText((Resolve-FilePath $ResultPath), $text, $encoding)
  }
  else {
    $resetInSeconds = $null
    if ($ResetMinutes -ne '' -and [long]$ResetMinutes -gt 0) { $resetInSeconds = [long]$ResetMinutes * 60 }
    Write-DemoModeSettings (Resolve-FilePath $Path) ($Enabled -ceq '1') $passcode $resetInSeconds
  }
}
catch {
  Write-Output $_
  exit 1
}
exit 0
