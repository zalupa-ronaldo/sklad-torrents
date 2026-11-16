# Launcher used by the SkladPcAgent / SkladDriveAgent scheduled tasks.
# Stopping a scheduled task ends only this launcher, not the node process it started.
# So every start first ends leftover node processes of the same agent, then runs node in the foreground.
param(
  [ValidateSet("job", "drive")][string]$Kind = "job"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$data = Join-Path $env:ProgramData "Sklad\agent"
$logDir = Join-Path $data "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$envFile = Join-Path $data "agent-env.json"
if (Test-Path $envFile) {
  $values = Get-Content -Raw -Path $envFile | ConvertFrom-Json
  foreach ($prop in $values.PSObject.Properties) { [Environment]::SetEnvironmentVariable($prop.Name, [string]$prop.Value, "Process") }
}
$node = if ($env:SKLAD_NODE) { $env:SKLAD_NODE } else { (Get-Command node -ErrorAction Stop).Source }

$patterns = if ($Kind -eq "job") { @("*pc-agent*windows*supervisor.mjs*", "*pc-agent*server.mjs*") } else { @("*pc-agent*drive.mts*") }
foreach ($pattern in $patterns) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like $pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Milliseconds 500

Set-Location $repo
if ($Kind -eq "job") {
  $log = Join-Path $logDir "supervisor.out.log"
  & $node (Join-Path $PSScriptRoot "supervisor.mjs") *>> $log
} else {
  $log = Join-Path $logDir "drive-agent.log"
  & $node --import ./agents/register.mjs agents/pc-agent/drive.mts --port 4372 *>> $log
}
exit $LASTEXITCODE
