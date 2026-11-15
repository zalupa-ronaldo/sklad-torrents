$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "SkladPcAgent" -Confirm:$false
Write-Output "SkladPcAgent removed"
