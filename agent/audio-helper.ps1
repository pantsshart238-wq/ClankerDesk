<#
ClankerDesk audio-helper.ps1 -- tiny, dependency-free helper for the agent.

Four jobs, one small process:

  1. -LoopbackMode [-LoopbackDevice "<name>"]
     LISTEN to whatever this PC is playing (WASAPI loopback -- the same
     mechanism OBS uses) and stream raw PCM to stdout. No VB-CABLE, no
     "Stereo Mix", nothing to install: the viewer hears exactly what the
     host hears, on any Windows 10+ machine. The agent pipes stdout into
     ffmpeg (opus) exactly like any other capture device. Empty
     -LoopbackDevice = the current DEFAULT output device; a name matches an
     active playback device (prefix match). Everything this mode prints is
     on STDERR -- stdout is pure PCM.

  2. -Borrow "<cable>" [-ReturnTo "<device>"]
     Switch the default playback device to <cable>, print "borrowed", then
     wait for a line on stdin (90s ceiling). When the line arrives (or the
     ceiling/pipe close hits), switch the default back. Used by the mic
     two-cable probe: ffplay can only render to the DEFAULT device, so the
     default is "borrowed" for the moment it starts.

  3. -DetectMicCable 1
     Scan the ACTIVE playback devices for a SECOND virtual cable (CABLE-B /
     CABLE-A of the free VB-CABLE A+B pack, or the free Voicemeeter virtual
     input) and print its short prefix -- or "none".

  4. -EnsureDefaultRender "<device>"
     Make <device> the default playback device (all three roles) and log one
     line.

No external tools and no PowerShell modules: device switching goes through
the stable IPolicyConfig COM interface (what Windows volume control apps
use); loopback capture goes through WASAPI (IMMDevice/IAudioClient).

GOTCHA honored throughout: PowerShell variables are CASE-INSENSITIVE and
typed params coerce on assignment -- never name a result variable after a
param (e.g. $borrow inside a function with param $Borrow: the object would
be silently stringified).
#>
param(
  [string]$Borrow = "",
  [string]$ReturnTo = "CABLE Input",
  [string]$EnsureDefaultRender = "",
  [string]$DetectMicCable = "",
  [switch]$LoopbackMode,
  [string]$LoopbackDevice = ""
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class CdAudio {
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  public class PolicyConfigClient { }

  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
    [PreserveSig] int GetDeviceFormat(string pszDeviceName, int bDefault, IntPtr ppFormat);
    [PreserveSig] int ResetDeviceFormat(string pszDeviceName);
    [PreserveSig] int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
    [PreserveSig] int GetProcessingPeriod(string pszDeviceName, int bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
    [PreserveSig] int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
    [PreserveSig] int GetShareMode(string pszDeviceName, IntPtr pMode);
    [PreserveSig] int SetShareMode(string pszDeviceName, IntPtr pMode);
    [PreserveSig] int GetPropertyValue(string pszDeviceName, int bFxStore, IntPtr key, IntPtr pv);
    [PreserveSig] int SetPropertyValue(string pszDeviceName, int bFxStore, IntPtr key, IntPtr pv);
    [PreserveSig] int SetDefaultEndpoint(string pszDeviceName, int eRole);
    [PreserveSig] int SetEndpointVisibility(string pszDeviceName, int bVisible);
  }

  // Set the default playback device for all three roles (console,
  // multimedia, communications) -- different apps read different roles.
  public static int SetDefault(string endpointId) {
    IPolicyConfig config = (IPolicyConfig)new PolicyConfigClient();
    int hr = 0;
    for (int role = 0; role <= 2; role++) {
      hr = config.SetDefaultEndpoint(endpointId, role);
      if (hr != 0) break;
    }
    return hr;
  }
}

// WASAPI loopback capture: records whatever plays on a render device
// (default device, or a named one) without touching the mix -- PCM goes to
// stdout, logs to stderr. Runs until the process is killed.
public static class CdLoopback {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr actParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int stgmAccess, out IntPtr props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint bufferFrames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr session);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr session);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint numFrames, out int flags, out long devPos, out long qpcPos);
    [PreserveSig] int ReleaseBuffer(uint numFrames);
    [PreserveSig] int GetNextPacketSize(out uint packetFrames);
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetDevice(out IntPtr device);
  }

  // The default render endpoint's id ("{0.0.0.00000000}.{guid}") -- the
  // PowerShell side uses it to order candidate devices default-first.
  public static string GetDefaultId() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice device;
    int hr = enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out device);
    if (hr != 0) return "";
    string id;
    hr = device.GetId(out id);
    return hr == 0 ? id : "";
  }

  // endpointId: the device to open ("" = the current default output).
  // acceptSilent: the last-resort fallback device may carry nothing right
  //   now (idle PC). Commit anyway -- silence is honest -- but if NO real
  //   audio ever appears within 60s, fail loudly so the caller re-walks the
  //   device list and can pick a better one (a wrong-but-alive device would
  //   otherwise listen to the wrong endpoint for the whole session).
  // label: human/agent-readable device name for the "listening to" log line
  //   (the agent caches it to skip the multi-second walk on relaunches).
  public static void Run(string endpointId, bool acceptSilent, string label) {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice device;
    int hr;
    if (string.IsNullOrEmpty(endpointId)) {
      hr = enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out device);
      if (hr != 0) throw new Exception("no active default output device (hr 0x" + hr.ToString("X8") + ")");
    } else {
      hr = enumerator.GetDevice(endpointId, out device);
      if (hr != 0) throw new Exception("output device not found (hr 0x" + hr.ToString("X8") + ")");
    }

    Guid iidAudioClient = typeof(IAudioClient).GUID;
    object clientObj;
    hr = device.Activate(ref iidAudioClient, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out clientObj);
    if (hr != 0) throw new Exception("IAudioClient activate failed (hr 0x" + hr.ToString("X8") + ")");
    IAudioClient client = (IAudioClient)clientObj;

    // Ask the shared engine for 48 kHz stereo s16 regardless of the device's
    // mix format (AUTOCONVERTPCM: WASAPI resamples for us), so the agent's
    // ffmpeg input args are always the same. Fall back to the mix format on
    // builds without that flag (Windows 10 1703+ has it).
    IntPtr wf = Marshal.AllocHGlobal(18); // WAVEFORMATEX
    try {
      for (int i = 0; i < 18; i++) Marshal.WriteByte(wf, i, 0);
      Marshal.WriteInt16(wf, 0, 1);            // wFormatTag = PCM
      Marshal.WriteInt16(wf, 2, 2);            // nChannels
      Marshal.WriteInt32(wf, 4, 48000);        // nSamplesPerSec
      Marshal.WriteInt32(wf, 8, 48000 * 4);    // nAvgBytesPerSec
      Marshal.WriteInt16(wf, 12, 4);           // nBlockAlign
      Marshal.WriteInt16(wf, 14, 16);          // wBitsPerSample
      Marshal.WriteInt16(wf, 16, 0);           // cbSize
      const int SHAREMODE_SHARED = 0;
      const int FLAG_LOOPBACK = 0x00020000;
      const int FLAG_AUTOCONVERTPCM = unchecked((int)0x80000000);
      const int FLAG_SRC_DEFAULT_QUALITY = 0x08000000;
      hr = client.Initialize(SHAREMODE_SHARED, FLAG_LOOPBACK | FLAG_AUTOCONVERTPCM | FLAG_SRC_DEFAULT_QUALITY,
                             2000000 /*200ms*/, 0, wf, IntPtr.Zero);
      if (hr != 0) {
        Console.Error.WriteLine("[loopback] 48k-s16 init failed (hr 0x" + hr.ToString("X8") + "); trying the device mix format");
        IntPtr mix;
        int hr2 = client.GetMixFormat(out mix);
        if (hr2 != 0) throw new Exception("GetMixFormat failed (hr 0x" + hr2.ToString("X8") + ")");
        // decode a few mix-format fields for the log (WAVEFORMATEX at mix)
        int mixCh = Marshal.ReadInt16(mix, 2);
        int mixRate = Marshal.ReadInt32(mix, 4);
        int mixBits = Marshal.ReadInt16(mix, 14);
        Console.Error.WriteLine("[loopback] mix format: " + mixRate + " Hz, " + mixCh + " ch, " + mixBits + " bit");
        if (mixBits != 16) throw new Exception("auto-convert unavailable and the mix format is " + mixBits + "-bit (cannot emit it as s16le)");
        // fresh client: a failed Initialize can leave the old one unusable
        object clientObj2;
        hr2 = device.Activate(ref iidAudioClient, 23, IntPtr.Zero, out clientObj2);
        if (hr2 != 0) throw new Exception("IAudioClient re-activate failed (hr 0x" + hr2.ToString("X8") + ")");
        client = (IAudioClient)clientObj2;
        hr = client.Initialize(SHAREMODE_SHARED, FLAG_LOOPBACK, 2000000, 0, mix, IntPtr.Zero);
        if (hr != 0) throw new Exception("mix-format Initialize failed (hr 0x" + hr.ToString("X8") + ")");
        Console.Error.WriteLine("[loopback] mix-format fallback active");
      }
    } finally {
      Marshal.FreeHGlobal(wf);
    }

    Guid iidCapture = typeof(IAudioCaptureClient).GUID;
    object capObj;
    hr = client.GetService(ref iidCapture, out capObj);
    if (hr != 0) throw new Exception("IAudioCaptureClient unavailable (hr 0x" + hr.ToString("X8") + ")");
    IAudioCaptureClient capture = (IAudioCaptureClient)capObj;

    System.IO.Stream stdout = Console.OpenStandardOutput();
    client.Start();
    // Grace: Initialize also succeeds on endpoints nothing plays on, so
    // prove this device actually carries audio before committing to it --
    // read (and discard) for up to 2s; silence-only fails so the caller
    // tries the next candidate. The first real frame starts real capture.
    Console.Error.WriteLine("[loopback] started; waiting for audio activity...");
    byte[] io = new byte[65536];
    DateTime startedAt = DateTime.UtcNow;
    DateTime deadline = startedAt.AddSeconds(2);
    bool proven = false;
    while (!proven) {
      uint packet;
      capture.GetNextPacketSize(out packet);
      while (packet > 0) {
        IntPtr data; uint frames; int flags; long p1; long p2;
        if (capture.GetBuffer(out data, out frames, out flags, out p1, out p2) != 0) break;
        bool real = (flags & 0x2) == 0 && data != IntPtr.Zero && frames > 0;
        if (real) {
          int bytes = (int)frames * 4; // 2ch * 16bit
          if (bytes > 0 && bytes <= io.Length) {
            Marshal.Copy(data, io, 0, bytes);
            // "Real" must mean MEANINGFUL amplitude: virtual mixers emit
            // +/-1 LSB dither constantly on their inputs, which would fool
            // a plain activity check into committing to a device that
            // carries nothing worth hearing. -54 dBFS floor.
            int peak = 0;
            for (int i = 0; i + 1 < bytes; i += 2) {
              int v = Math.Abs((int)BitConverter.ToInt16(io, i));
              if (v > peak) peak = v;
            }
            if (peak >= 64) {
              stdout.Write(io, 0, bytes);
              proven = true;
            }
          }
        }
        capture.ReleaseBuffer(frames);
        if (proven) break;
        capture.GetNextPacketSize(out packet);
      }
      if (proven) break;
      if (DateTime.UtcNow > deadline) {
        if (!acceptSilent) {
          client.Stop();
          throw new Exception("silent -- no real audio in 2s");
        }
        Console.Error.WriteLine("[loopback] no real audio right now -- committing to this device anyway");
        break;
      }
      System.Threading.Thread.Sleep(5);
    }
    Console.Error.WriteLine("[loopback] listening to '" + label + "' (48000 Hz stereo s16le on stdout)");
    bool neverProven = !proven; // committed by acceptSilent, not by real audio
    while (true) {
      uint packet;
      capture.GetNextPacketSize(out packet);
      while (packet > 0) {
        IntPtr data; uint frames; int flags; long p1; long p2;
        if (capture.GetBuffer(out data, out frames, out flags, out p1, out p2) != 0) break;
        int bytes = (int)frames * 4; // 2ch * 16bit
        if (bytes > 0 && bytes <= io.Length) {
          if ((flags & 0x2) != 0 || data == IntPtr.Zero) { // AUDCLNT_BUFFERFLAGS_SILENT
            for (int i = 0; i < bytes; i++) io[i] = 0;
            stdout.Write(io, 0, bytes);
          } else {
            Marshal.Copy(data, io, 0, bytes);
            stdout.Write(io, 0, bytes);
            if (neverProven) {
              int pk = 0;
              for (int i = 0; i + 1 < bytes; i += 2) {
                int v = Math.Abs((int)BitConverter.ToInt16(io, i));
                if (v > pk) pk = v;
              }
              if (pk >= 64) {
                neverProven = false;
                Console.Error.WriteLine("[loopback] real audio arrived on this device");
              }
            }
          }
        }
        capture.ReleaseBuffer(frames);
        capture.GetNextPacketSize(out packet);
      }
      if (neverProven && (DateTime.UtcNow - startedAt).TotalSeconds > 60) {
        // The acceptSilent fallback has heard nothing real for a minute: it
        // is probably the WRONG device (e.g. a virtual input while the real
        // audio goes elsewhere). Fail so the PowerShell walk retries the
        // whole list -- the agent relaunches us in 2s.
        client.Stop();
        throw new Exception("no real audio on this device within 60s -- picking a different one");
      }
      System.Threading.Thread.Sleep(5);
    }
  }
}
"@

function Get-AudioEndpoints {
  # Active playback devices, straight from the MMDevices registry (no module
  # needed). DeviceState 1 = DEVICE_STATE_ACTIVE. The device name lives in
  # Properties\{a45c254e-df1c-4efd-8020-67d146a850e0},2 -- a plain string on
  # current Windows builds ("CABLE Input", "Voicemeeter Input"), but older
  # builds store UTF-16LE bytes; both are handled.
  $base = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
  $list = @()
  foreach ($k in @(Get-ChildItem -Path $base -ErrorAction SilentlyContinue)) {
    try {
      $keyProps = Get-ItemProperty -Path $k.PSPath -ErrorAction Stop
      if ($keyProps.DeviceState -ne 1) { continue }
      $descVal = (Get-ItemProperty -Path (Join-Path $k.PSPath "Properties") -ErrorAction Stop).'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
      if (-not $descVal) { continue }
      if ($descVal -is [byte[]]) {
        $name = [System.Text.Encoding]::Unicode.GetString($descVal).TrimEnd([char]0)
      } else {
        $name = [string]$descVal
      }
      # SetDefaultEndpoint needs the ENDPOINT ID (friendly names are rejected
      # with E_INVALIDARG); MMDevices stores it as "{0.0.0.00000000}." + the
      # key's GUID.
      if ($name) { $list += [pscustomobject]@{ Name = $name; Id = "{0.0.0.00000000}." + $k.PSChildName } }
    } catch { }
  }
  return $list
}

function Set-DefaultRender([string]$endpointId) {
  $hr = [CdAudio]::SetDefault($endpointId)
  if ($hr -ne 0) {
    throw ('SetDefaultEndpoint("' + $endpointId + '") failed, HRESULT 0x' + ('{0:X8}' -f $hr))
  }
  Start-Sleep -Milliseconds 300  # let the audio stack settle before ffplay opens
}

if ($LoopbackMode) {
  # stdout = raw PCM ONLY. Every message goes to stderr. Candidates run in
  # order -- the requested/default output first, then every other active
  # output. Two realities make the list necessary: some drivers refuse
  # loopback on their own endpoints (VB-CABLE answers AUDCLNT_E_DEVICE_IN_USE),
  # and an endpoint nothing plays on stays silent forever. Run() only
  # commits to a device that actually carries audio.
  try {
    $endpoints = Get-AudioEndpoints
    $candidates = @()
    if ($LoopbackDevice) {
      $namedDev = $endpoints | Where-Object { $_.Name -like "$LoopbackDevice*" } | Select-Object -First 1
      if ($namedDev) { $candidates += $namedDev }
      else { [Console]::Error.WriteLine("output device '" + $LoopbackDevice + "' not found; trying the default output instead") }
    }
    if (-not $candidates) {
      $defId = [CdLoopback]::GetDefaultId()
      $defDev = $endpoints | Where-Object { $_.Id -eq $defId } | Select-Object -First 1
      if ($defDev) { $candidates += $defDev }
      elseif ($defId) { $candidates += [pscustomobject]@{ Name = "default output"; Id = $defId } }
    }
    if ($candidates) {
      $candidates += $endpoints | Where-Object { $_.Id -ne $candidates[0].Id }
    }
    $firstInited = $null
    foreach ($cand in $candidates) {
      [Console]::Error.WriteLine("[loopback] trying '" + $cand.Name + "'")
      try {
        [CdLoopback]::Run($cand.Id, $false, $cand.Name)
        exit 0
      } catch {
        $why = $_.Exception.Message
        [Console]::Error.WriteLine("[loopback] '" + $cand.Name + "': " + $why)
        if (-not $firstInited -and $why -like "*silent*") { $firstInited = $cand }
      }
    }
    # Nothing carries real audio anywhere (a fully idle PC). Fall back to the
    # first device that accepted capture at all, so sound flows the moment
    # something starts playing instead of the agent restarting us forever.
    if ($firstInited) {
      [Console]::Error.WriteLine("[loopback] nothing is playing anywhere right now; sticking with '" + $firstInited.Name + "'")
      try { [CdLoopback]::Run($firstInited.Id, $true, $firstInited.Name); exit 0 }
      catch { [Console]::Error.WriteLine("[loopback] '" + $firstInited.Name + "': " + $_.Exception.Message) }
    }
    [Console]::Error.WriteLine("no output device carried audio; giving up")
    exit 1
  } catch {
    [Console]::Error.WriteLine("loopback failed: " + $_.Exception.Message)
    exit 1
  }
}

if ($Borrow) {
  try {
    $devices = Get-AudioEndpoints
    # NOTE: result variables deliberately do NOT mirror param names ($Borrow/
    # $ReturnTo): PowerShell vars are case-insensitive and typed params
    # coerce on assignment -- $borrow would be silently stringified.
    $borrowDev = $devices | Where-Object { $_.Name -like "$Borrow*" } | Select-Object -First 1
    if (-not $borrowDev) { throw "no active playback device starting with '$Borrow'" }
    $returnDev = $devices | Where-Object { $_.Name -like "$ReturnTo*" } | Select-Object -First 1
    Set-DefaultRender $borrowDev.Id
    Write-Output "borrowed"
    # Wait for the agent to hand the default back (it writes one line on
    # stdin). The 90s ceiling covers an agent crash mid-handoff: we always
    # restore -- nothing leaves this PC with its default moved for good.
    try {
      $task = [System.Console]::In.ReadLineAsync()
      [void]$task.Wait(90000)
    } catch { }  # broken pipe (agent died) = restore right now
    if ($returnDev) {
      try { Set-DefaultRender $returnDev.Id } catch { Write-Output ("restore failed: " + $_.Exception.Message) }
    }
    exit 0
  } catch {
    Write-Output ("borrow failed: " + $_.Exception.Message)
    exit 1
  }
}

if ($DetectMicCable) {
  try {
    $devices = Get-AudioEndpoints
    $secondDev = $devices | Where-Object { $_.Name -match '^CABLE-B' } | Select-Object -First 1
    if (-not $secondDev) { $secondDev = $devices | Where-Object { $_.Name -match '^CABLE-A' } | Select-Object -First 1 }
    if (-not $secondDev) { $secondDev = $devices | Where-Object { $_.Name -match '^Voicemeeter Input' } | Select-Object -First 1 }
    if (-not $secondDev) { Write-Output "none" }
    elseif ($secondDev.Name -match '^Voicemeeter Input') { Write-Output "Voicemeeter Input" }
    elseif ($secondDev.Name -match '^(CABLE-[AB])') { Write-Output $Matches[1] }
    else { Write-Output "none" }
    exit 0
  } catch {
    Write-Output "none"
    exit 1
  }
}

if ($EnsureDefaultRender) {
  try {
    $devices = Get-AudioEndpoints
    $targetDev = $devices | Where-Object { $_.Name -like "$EnsureDefaultRender*" } | Select-Object -First 1
    if (-not $targetDev) {
      Write-Output ("'" + $EnsureDefaultRender + "' not found among active playback devices; default playback left alone")
      exit 0
    }
    Set-DefaultRender $targetDev.Id
    Write-Output ("default playback device: " + $targetDev.Name)
    exit 0
  } catch {
    Write-Output ("default playback device NOT set: " + $_.Exception.Message)
    exit 1
  }
}

Write-Output "nothing to do (pass -LoopbackMode, -Borrow, -DetectMicCable 1, or -EnsureDefaultRender <device>)"
exit 1
