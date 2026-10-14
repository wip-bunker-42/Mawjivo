param(
  [Parameter(Mandatory = $true)][string]$ApplicationPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MawjivoTransferDialog {
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
function Wait-For([scriptblock]$Operation, [int]$Seconds = 15) {
  $taskTimer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $taskValue = & $Operation
    if ($null -ne $taskValue -and $taskValue -ne $false) { return $taskValue }
    Start-Sleep -Milliseconds 150
  } while ($taskTimer.Elapsed.TotalSeconds -lt $Seconds)
  throw 'Native settings dialog did not reach the expected state.'
}
function Assert-True($Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}
$taskPath = [IO.Path]::GetFullPath($ApplicationPath)
$taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name='mawjivo.exe'" |
  Where-Object { $_.ExecutablePath -eq $taskPath })
Assert-True ($taskProcesses.Count -eq 1) 'Expected one exact installed application process.'
$taskProcessId = [int]$taskProcesses[0].ProcessId
$taskDesktop = [System.Windows.Automation.AutomationElement]::RootElement
$taskProcessCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $taskProcessId)
function Windows {
  $taskDesktop.FindAll([System.Windows.Automation.TreeScope]::Children, $taskProcessCondition)
  if ($taskApp) {
    $taskDialogCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
    $taskApp.FindAll([System.Windows.Automation.TreeScope]::Descendants, $taskDialogCondition)
  }
}
$taskApp = Wait-For { Windows | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1 }
$taskAppHandle = [intptr]$taskApp.Current.NativeWindowHandle
function Button([string]$Name) {
  $taskCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $taskApp.FindAll([System.Windows.Automation.TreeScope]::Descendants, $taskCondition) |
    Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } |
    Select-Object -First 1
}
function Click([string]$Name) {
  $taskButton = Wait-For { Button $Name }
  Assert-True $taskButton.Current.IsEnabled "The native button is unavailable: $Name"
  $taskPattern = $null
  if ($taskButton.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$taskPattern)) {
    ([System.Windows.Automation.InvokePattern]$taskPattern).Invoke()
  } elseif ($taskButton.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$taskPattern)) {
    ([System.Windows.Automation.TogglePattern]$taskPattern).Toggle()
  } else { throw "The native button has no supported action: $Name" }
}
if (-not (Button 'تصدير الإعدادات والحسابات')) {
  Click 'الإعدادات'
  Click 'نقل الإعدادات والحسابات'
}
$taskExport = Wait-For { Button 'تصدير الإعدادات والحسابات' }
$taskImport = Wait-For { Button 'استيراد الإعدادات والحسابات' }
$taskExportBounds = $taskExport.Current.BoundingRectangle
$taskImportBounds = $taskImport.Current.BoundingRectangle
$taskStacked = $taskImportBounds.Top -ge $taskExportBounds.Bottom -and
  [Math]::Abs($taskImportBounds.Left - $taskExportBounds.Left) -lt 2
$taskProof = [ordered]@{ schema = 1; stackedButtons = $taskStacked; nativeDialogs = @() }
foreach ($taskMode in @('export', 'import')) {
  $taskName = if ($taskMode -eq 'export') { 'تصدير الإعدادات والحسابات' } else { 'استيراد الإعدادات والحسابات' }
  $taskDialog = $null
  try {
    Click $taskName
    $taskDialog = Wait-For { Windows | Where-Object {
      $_.Current.ClassName -eq '#32770' -and $_.Current.Name -eq $taskName
    } | Select-Object -First 1 }
    $taskDialogHandle = [intptr]$taskDialog.Current.NativeWindowHandle
    $taskOwner = [MawjivoTransferDialog]::GetWindow($taskDialogHandle, 4)
    Assert-True ($taskOwner -eq $taskAppHandle) 'The settings file dialog is not owned by the calling application window.'
    Assert-True (-not $taskApp.Current.IsEnabled) 'The parent window should be modal while its file dialog is open.'
    $taskTimer = [Diagnostics.Stopwatch]::StartNew()
    [MawjivoTransferDialog]::PostMessage($taskDialogHandle, 0x10, [intptr]::Zero, [intptr]::Zero) | Out-Null
    Wait-For { (Button $taskName).Current.IsEnabled } | Out-Null
    $taskProof.nativeDialogs += [ordered]@{ operation = $taskMode; ownedByCallingWindow = $true;
      modal = $true; cancellationReturned = $true;
      elapsedMs = [int]$taskTimer.Elapsed.TotalMilliseconds }
  } finally {
    if ($taskDialog) {
      [MawjivoTransferDialog]::PostMessage([intptr]$taskDialog.Current.NativeWindowHandle,
        0x10, [intptr]::Zero, [intptr]::Zero) | Out-Null
    }
  }
}
Assert-True $taskStacked 'The settings transfer buttons are not stacked vertically.'
$taskProof.verifiedAt = [DateTime]::UtcNow.ToString('o')
$taskProof | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output 'Native settings dialogs verified.'
