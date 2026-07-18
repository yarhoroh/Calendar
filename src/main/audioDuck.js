import { spawn } from 'child_process'
import { basename, join } from 'path'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'

// Temporarily "ducks" (mutes) every OTHER app's audio while the говорилка speaks,
// then restores it — so a short spoken phrase is heard clearly over music/video.
//
// Windows has no per-app volume control exposed to Node/Electron, and this machine
// has no C++ toolchain to build a native addon. So we drive the Core Audio (WASAPI)
// session API through a SINGLE long-lived PowerShell host that compiles a tiny C#
// helper once (via Add-Type) and then takes DUCK/UNDUCK commands on stdin — the same
// "spawn powershell" approach already used for the Windows SAPI voice, but persistent
// so we don't pay the ~1s C# compile on every phrase.
//
// "Other app" = any audio session whose process is NOT one of ours. Every Electron
// process (main, renderer, GPU, audio service) runs the same executable, so matching
// by exe base name reliably leaves our own speech untouched while muting the rest.

// C# WASAPI helper: MuteOthers(ownName) mutes each render session on the default
// output device whose process name differs from ours (and that the user hasn't
// already muted), returning the pids it touched; Unmute(pids) reverses exactly those.
const CSHARP = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Ducker {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f0(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 { int f0(); int f1(); int GetSessionEnumerator(out IAudioSessionEnumerator e); }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, out IAudioSessionControl s); }
  // IAudioSessionControl2 — declare every base slot (1..11) before GetProcessId (12) so the vtable lines up
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int s); int GetDisplayName(out IntPtr p); int SetDisplayName(string n, ref Guid c);
    int GetIconPath(out IntPtr p); int SetIconPath(string n, ref Guid c);
    int GetGroupingParam(out Guid g); int SetGroupingParam(ref Guid g, ref Guid c);
    int RegisterAudioSessionNotification(IntPtr n); int UnregisterAudioSessionNotification(IntPtr n);
    int GetSessionIdentifier(out IntPtr p); int GetSessionInstanceIdentifier(out IntPtr p);
    int GetProcessId(out int pid); int IsSystemSoundsSession(); int SetDuckingPreference(bool opt);
  }
  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl { int f0(); }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float l, ref Guid c); int GetMasterVolume(out float l);
    int SetMute(bool m, ref Guid c); int GetMute(out bool m);
  }
  static IAudioSessionEnumerator Sessions() {
    var de = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; if (de.GetDefaultAudioEndpoint(0, 1, out dev) != 0 || dev == null) return null;
    Guid iid = typeof(IAudioSessionManager2).GUID; object o;
    if (dev.Activate(ref iid, 1, IntPtr.Zero, out o) != 0 || o == null) return null;
    IAudioSessionEnumerator e; ((IAudioSessionManager2)o).GetSessionEnumerator(out e); return e;
  }
  public static int[] MuteOthers(string ownName) {
    var muted = new List<int>(); var e = Sessions(); if (e == null) return muted.ToArray();
    Guid empty = Guid.Empty; int n; e.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IAudioSessionControl c; if (e.GetSession(i, out c) != 0 || c == null) continue;
      int pid; ((IAudioSessionControl2)c).GetProcessId(out pid); if (pid == 0) continue;
      string name = ""; try { name = Process.GetProcessById(pid).ProcessName; } catch {}
      if (name.Length == 0 || string.Equals(name, ownName, StringComparison.OrdinalIgnoreCase)) continue;
      var v = (ISimpleAudioVolume)c; bool m; if (v.GetMute(out m) != 0 || m) continue;
      v.SetMute(true, ref empty); muted.Add(pid);
    }
    return muted.ToArray();
  }
  public static void Unmute(int[] pids) {
    var e = Sessions(); if (e == null || pids == null) return;
    Guid empty = Guid.Empty; int n; e.GetCount(out n);
    var set = new HashSet<int>(pids);
    for (int i = 0; i < n; i++) {
      IAudioSessionControl c; if (e.GetSession(i, out c) != 0 || c == null) continue;
      int pid; ((IAudioSessionControl2)c).GetProcessId(out pid);
      if (!set.Contains(pid)) continue;
      ((ISimpleAudioVolume)c).SetMute(false, ref empty);
    }
  }
}`

// The host reads ownName on the first line, then loops on DUCK/UNDUCK. It keeps the
// muted-pid list itself, so a repeated DUCK (queue kept speaking) is a no-op and never
// loses the original list, and QUIT exits cleanly.
const HOST_SCRIPT = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
$own = [Console]::In.ReadLine()
$muted = @()
while (($cmd = [Console]::In.ReadLine()) -ne $null) {
  try {
    if ($cmd -eq 'DUCK') { if ($muted.Count -eq 0) { $muted = [Ducker]::MuteOthers($own) } }
    elseif ($cmd -eq 'UNDUCK') { if ($muted.Count -gt 0) { [Ducker]::Unmute($muted) }; $muted = @() }
    elseif ($cmd -eq 'QUIT') { if ($muted.Count -gt 0) { [Ducker]::Unmute($muted) }; break }
  } catch {}
  [Console]::Out.WriteLine('OK')
}`

let host = null // the live PowerShell process (null until first duck / after a crash)
let ducked = false // our view of whether the background is currently muted
let scriptPath = null // temp .ps1 written once per session

// Run the host from a temp .ps1 via -File (NOT -Command -, which would consume our
// whole stdin as the script and leave no channel for the DUCK/UNDUCK lines). With
// -File, stdin stays free: the script reads ownName then commands line by line.
function ensureHost() {
  if (host) return host
  try {
    if (!scriptPath) {
      scriptPath = join(tmpdir(), 'cal-tts-duck-host.ps1')
      writeFileSync(scriptPath, HOST_SCRIPT, 'utf8')
    }
    host = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true
    })
  } catch {
    host = null
    return null
  }
  host.stdout?.on('data', () => {}) // drain acks
  host.stderr?.on('data', () => {})
  const drop = () => {
    host = null
    ducked = false
  }
  host.on('error', drop)
  host.on('close', drop)
  try {
    host.stdin.write(basename(process.execPath, '.exe') + '\n') // ownName (first line)
  } catch {
    drop()
    return null
  }
  return host
}

// Mute every other app's audio (idempotent — a second call while already ducked does nothing).
export function duck() {
  if (ducked) return
  const h = ensureHost()
  if (!h) return
  try {
    h.stdin.write('DUCK\n')
    ducked = true
  } catch {
    // host died between ensure and write — next duck will respawn
  }
}

// Restore whatever we muted.
export function unduck() {
  if (!ducked || !host) {
    ducked = false
    return
  }
  try {
    host.stdin.write('UNDUCK\n')
  } catch {
    // ignore
  }
  ducked = false
}

// Clean shutdown: let the host un-mute anything still ducked, then exit.
export function stopAudioDuck() {
  if (!host) return
  try {
    host.stdin.write('QUIT\n')
    host.stdin.end()
  } catch {
    try {
      host.kill()
    } catch {
      // ignore
    }
  }
  host = null
  ducked = false
}
