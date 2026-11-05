# Lists optical drives on Windows.
# WMI Win32_CDROMDrive plus IMAPI2 (MsftDiscMaster2 / MsftDiscFormat2Data).
# Does not write, erase, or burn. Prints one JSON array to stdout.
$ErrorActionPreference = "Stop"

$drives = @(Get-CimInstance -ClassName Win32_CDROMDrive)
$recorders = @()

try {
  $master = New-Object -ComObject IMAPI2.MsftDiscMaster2
  for ($i = 0; $i -lt $master.Count; $i++) {
    $id = $master.Item($i)
    $recorder = New-Object -ComObject IMAPI2.MsftDiscRecorder2
    $recorder.InitializeDiscRecorder($id)
    $paths = @($recorder.VolumePathNames)
    $mediaType = $null
    try {
      $format = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
      $format.Recorder = $recorder
      $mediaType = [int]$format.CurrentPhysicalMediaType
    } catch {
      $mediaType = $null
    }
    $recorders += [pscustomobject]@{
      recorderId = [string]$id
      paths = $paths
      imapiMediaType = $mediaType
    }
  }
} catch {
  # IMAPI2 is optional here: WMI rows are still returned.
}

$result = foreach ($drive in $drives) {
  $letter = [string]$drive.Drive
  $match = $null
  foreach ($recorder in $recorders) {
    $paths = @($recorder.paths)
    if ($paths -contains $letter -or $paths -contains ($letter + "\")) {
      $match = $recorder
      break
    }
  }
  [pscustomobject]@{
    deviceId = [string]$drive.DeviceID
    name = [string]$drive.Name
    drive = $letter
    mediaLoaded = [bool]$drive.MediaLoaded
    mediaType = [string]$drive.MediaType
    caption = [string]$drive.Caption
    pnpDeviceId = [string]$drive.PNPDeviceID
    recorderId = $(if ($match) { [string]$match.recorderId } else { $letter })
    imapiMediaType = $(if ($match) { $match.imapiMediaType } else { $null })
  }
}

if (-not $result) {
  "[]"
  exit 0
}

@($result) | ConvertTo-Json -Compress
exit 0
