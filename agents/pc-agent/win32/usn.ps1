# Windows-only. Opens \\.\X: and reads NTFS MFT enumeration (FSCTL_ENUM_USN_DATA)
# or the USN journal (FSCTL_READ_USN_JOURNAL). Not used for APFS or /Volumes.
# Tests do not execute this script.
$ErrorActionPreference = "Stop"
$letter = [string]$env:SKLAD_VOLUME
if ($letter -notmatch '^[A-Z]$') { throw "SKLAD_VOLUME must be a drive letter." }
foreach ($item in ([string]$env:SKLAD_EXCLUDE_LETTERS).ToUpper().Split(',')) {
  $token = $item.Trim().TrimEnd(':')
  if ($token -eq $letter) { throw "Том исключён до открытия устройства." }
}
$mode = [string]$env:SKLAD_MODE
$startText = [string]$env:SKLAD_START_USN
if ([string]::IsNullOrWhiteSpace($startText)) { $startText = "0" }

if ($mode -eq "elevated") {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Output "yes" } else { Write-Output "no" }
  exit 0
}

$csharp = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NtfsVolume {
  const uint GENERIC_READ = 0x80000000;
  const uint SHARE = 1 | 2 | 4;
  const uint OPEN_EXISTING = 3;
  const uint FSCTL_ENUM_USN_DATA = 0x000900B3;
  const uint FSCTL_READ_USN_JOURNAL = 0x000900BB;
  const uint FSCTL_QUERY_USN_JOURNAL = 0x000900F4;
  const int ERROR_HANDLE_EOF = 38;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  public static void Enumerate(string letter) {
    IntPtr handle = Open(letter);
    try {
      var records = new List<byte>();
      ulong cursor = 0;
      for (int step = 0; step < 200000; step++) {
        byte[] input = new byte[24];
        WriteU64(input, 0, cursor);
        WriteU64(input, 8, 0);
        WriteU64(input, 16, 0x7FFFFFFFFFFFFFFFUL);
        byte[] output = Control(handle, FSCTL_ENUM_USN_DATA, input, 1024 * 1024);
        if (output == null || output.Length <= 8) break;
        cursor = ReadU64(output, 0);
        Append(records, output, 8);
        if (records.Count > 64 * 1024 * 1024) break;
      }
      Console.Write(Convert.ToBase64String(records.ToArray()));
    } finally {
      CloseHandle(handle);
    }
  }

  public static void ReadJournal(string letter, long startUsn) {
    IntPtr handle = Open(letter);
    try {
      byte[] journal = Control(handle, FSCTL_QUERY_USN_JOURNAL, new byte[0], 64);
      if (journal == null || journal.Length < 24) throw new InvalidOperationException("USN journal is not active.");
      ulong journalId = ReadU64(journal, 0);
      var records = new List<byte>();
      long cursor = startUsn;
      for (int step = 0; step < 200000; step++) {
        byte[] input = new byte[40];
        WriteU64(input, 0, unchecked((ulong)cursor));
        WriteU32(input, 8, 0xFFFFFFFF);
        WriteU32(input, 12, 0);
        WriteU64(input, 16, 0);
        WriteU64(input, 24, 0);
        WriteU64(input, 32, journalId);
        byte[] output = Control(handle, FSCTL_READ_USN_JOURNAL, input, 1024 * 1024);
        if (output == null || output.Length <= 8) break;
        cursor = unchecked((long)ReadU64(output, 0));
        Append(records, output, 8);
        if (records.Count > 32 * 1024 * 1024) break;
      }
      Console.Write(Convert.ToBase64String(records.ToArray()));
    } finally {
      CloseHandle(handle);
    }
  }

  static IntPtr Open(string letter) {
    IntPtr handle = CreateFileW("\\\\.\\" + letter + ":", GENERIC_READ, SHARE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (handle == IntPtr.Zero || handle.ToInt64() == -1) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return handle;
  }

  static byte[] Control(IntPtr handle, uint code, byte[] input, int outCap) {
    if (input == null) input = new byte[0];
    int inSize = Math.Max(input.Length, 1);
    IntPtr inPtr = Marshal.AllocHGlobal(inSize);
    IntPtr outPtr = Marshal.AllocHGlobal(outCap);
    try {
      if (input.Length > 0) Marshal.Copy(input, 0, inPtr, input.Length);
      uint returned;
      bool ok = DeviceIoControl(handle, code, input.Length == 0 ? IntPtr.Zero : inPtr, (uint)input.Length, outPtr, (uint)outCap, out returned, IntPtr.Zero);
      if (!ok) {
        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_HANDLE_EOF) return null;
        throw new System.ComponentModel.Win32Exception(error);
      }
      if (returned == 0) return new byte[0];
      byte[] data = new byte[returned];
      Marshal.Copy(outPtr, data, 0, (int)returned);
      return data;
    } finally {
      Marshal.FreeHGlobal(inPtr);
      Marshal.FreeHGlobal(outPtr);
    }
  }

  static void Append(List<byte> target, byte[] source, int offset) {
    for (int i = offset; i < source.Length; i++) target.Add(source[i]);
  }

  static void WriteU64(byte[] buffer, int offset, ulong value) {
    for (int i = 0; i < 8; i++) buffer[offset + i] = (byte)((value >> (8 * i)) & 0xFF);
  }

  static void WriteU32(byte[] buffer, int offset, uint value) {
    for (int i = 0; i < 4; i++) buffer[offset + i] = (byte)((value >> (8 * i)) & 0xFF);
  }

  static ulong ReadU64(byte[] buffer, int offset) {
    ulong value = 0;
    for (int i = 0; i < 8; i++) value |= (ulong)buffer[offset + i] << (8 * i);
    return value;
  }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp
if ($mode -eq "journal") {
  [NtfsVolume]::ReadJournal($letter, [int64]$startText)
} else {
  [NtfsVolume]::Enumerate($letter)
}
