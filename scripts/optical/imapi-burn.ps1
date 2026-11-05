# Burns a staged folder with IMAPI2, or only erases when BOTH -Erase and -EraseOnly are set.
# -Erase is a switch. The Node plan passes -Erase:$false unless the job stored a confirmation.
# This file is not executed by tests.
param(
  [string]$Source = "",
  [string]$Image = "",
  [string]$RecorderId = "",
  [switch]$Erase,
  [switch]$EraseOnly
)

$ErrorActionPreference = "Stop"

function Get-Recorder([string]$Id) {
  if (-not $Id) { throw "RecorderId is required" }
  $master = New-Object -ComObject IMAPI2.MsftDiscMaster2
  $recorder = New-Object -ComObject IMAPI2.MsftDiscRecorder2
  $recorder.InitializeDiscRecorder($Id)
  return $recorder
}

try {
  if ($EraseOnly -and -not $Erase) {
    Write-Error "Erase was not confirmed."
    exit 2
  }

  $recorder = Get-Recorder $RecorderId

  if ($Erase) {
    $eraser = New-Object -ComObject IMAPI2.MsftDiscFormat2Erase
    $eraser.Recorder = $recorder
    $eraser.ClientName = "Sklad"
    $eraser.FullErase = $false
    $eraser.EraseMedia()
  }

  if ($EraseOnly) { exit 0 }
  if (-not $Source) { throw "Source folder is required" }
  if (-not (Test-Path -LiteralPath $Source)) { throw "Source folder was not found" }

  $filesystem = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $filesystem.ChooseImageDefaults($recorder)
  $filesystem.FileSystemsToCreate = 3
  $filesystem.VolumeName = "SKLAD"
  $root = $filesystem.Root
  $root.AddTree($Source, $false) | Out-Null
  $resultImage = $filesystem.CreateResultImage()
  $stream = $resultImage.ImageStream

  $data = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
  $data.Recorder = $recorder
  $data.ClientName = "Sklad"
  $data.Write($stream)
  exit 0
} catch {
  Write-Error $_
  exit 1
}
