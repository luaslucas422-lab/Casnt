// Windows helper: one long-running PowerShell process that
//  - presses keys for TikTok gift actions (SendInput with scan codes, so games see them too)
//  - reads and controls the "now playing" media session (Spotify) via Windows' media controls
//  - checks whether Spotify is installed
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class CasntInput {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  static bool Extended(ushort vk) {
    return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0xA3 || vk == 0xA5;
  }
  static void Send(KEYBDINPUT k) {
    INPUT[] inp = new INPUT[1];
    inp[0].type = 1;
    inp[0].u.ki = k;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  static void Key(ushort vk, bool up) {
    KEYBDINPUT k = new KEYBDINPUT();
    k.wScan = (ushort)MapVirtualKey(vk, 0);
    k.dwFlags = 0x0008;
    if (up) k.dwFlags |= 0x0002;
    if (Extended(vk)) k.dwFlags |= 0x0001;
    Send(k);
  }
  public static void Press(ushort[] vks, int holdMs) {
    foreach (ushort v in vks) Key(v, false);
    Thread.Sleep(Math.Max(10, holdMs));
    for (int i = vks.Length - 1; i >= 0; i--) Key(vks[i], true);
  }
  public static void Media(ushort vk) {
    KEYBDINPUT k = new KEYBDINPUT(); k.wVk = vk; k.dwFlags = 0x0001; Send(k);
    KEYBDINPUT u = new KEYBDINPUT(); u.wVk = vk; u.dwFlags = 0x0001 | 0x0002; Send(u);
  }
}
"@

$script:mgr = $null
$script:asTask = $null
$script:lastArtKey = ''
function Await($op, [Type]$type) {
  if (-not $script:asTask) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1'
    })[0]
  }
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}
function Manager() {
  if (-not $script:mgr) {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  return $script:mgr
}
function Session() {
  $m = Manager
  $s = $m.GetSessions() | Where-Object { $_.SourceAppUserModelId -like '*Spotify*' } | Select-Object -First 1
  if (-not $s) { $s = $m.GetCurrentSession() }
  return $s
}
function MediaState($withArt) {
  $s = Session
  if (-not $s) { return @{ active = $false } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $r = @{
    active = $true; app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
    playing = ([int]$info.PlaybackStatus -eq 4)
    position = [math]::Round($tl.Position.TotalSeconds); duration = [math]::Round($tl.EndTime.TotalSeconds)
  }
  $key = "$($p.Title)|$($p.Artist)"
  if ($p.Thumbnail -and ($withArt -or $key -ne $script:lastArtKey)) {
    try {
      $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
      $ms = New-Object System.IO.MemoryStream
      $net.CopyTo($ms)
      $r.art = [Convert]::ToBase64String($ms.ToArray())
      $script:lastArtKey = $key
    } catch { }
  }
  return $r
}
function MediaDo($action) {
  $s = Session
  if (-not $s) {
    switch ($action) { 'next' { [CasntInput]::Media(0xB0) } 'prev' { [CasntInput]::Media(0xB1) } default { [CasntInput]::Media(0xB3) } }
    return $true
  }
  switch ($action) {
    'next' { return Await ($s.TrySkipNextAsync()) ([bool]) }
    'prev' { return Await ($s.TrySkipPreviousAsync()) ([bool]) }
    'play' { return Await ($s.TryPlayAsync()) ([bool]) }
    'pause' { return Await ($s.TryPauseAsync()) ([bool]) }
    default { return Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
  }
}
function SpotifyInfo() {
  $exe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
  $store = $null
  try { $store = Get-AppxPackage -Name 'SpotifyAB.SpotifyMusic' -ErrorAction SilentlyContinue } catch { }
  $running = $null -ne (Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue)
  return @{ installed = ((Test-Path $exe) -or ($null -ne $store)); running = $running; desktop = (Test-Path $exe); store = ($null -ne $store) }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $data = $null
    switch ($req.cmd) {
      'keys' { [CasntInput]::Press([uint16[]]$req.vks, [int]$req.hold); $data = $true }
      'media_state' { $data = MediaState ([bool]$req.art) }
      'media' { $data = MediaDo $req.action }
      'spotify' { $data = SpotifyInfo }
      'ping' { $data = 'pong' }
    }
    $out = @{ id = $req.id; ok = $true; data = $data }
  } catch {
    $out = @{ id = $(if ($req) { $req.id } else { 0 }); ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
`;

// Key names -> Windows virtual-key codes
const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, pause: 0x13, capslock: 0x14,
  esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, insert: 0x2d, delete: 0x2e, del: 0x2e,
  win: 0x5b, lshift: 0xa0, rshift: 0xa1, lctrl: 0xa2, rctrl: 0xa3, lalt: 0xa4, ralt: 0xa5,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) { VK[String(i)] = 0x30 + i; VK['num' + i] = 0x60 + i; }
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6f + i;

/** "ctrl+shift+r" -> [0x11, 0x10, 0x52]; throws on unknown keys. */
function parseKeys(spec) {
  const parts = String(spec || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no keys');
  return parts.map((p) => {
    if (!(p in VK)) throw new Error(`unknown key "${p}"`);
    return VK[p];
  });
}

class WinHelper {
  constructor() {
    this.proc = null;
    this.next = 1;
    this.pending = new Map();
    this.buf = '';
  }

  available() { return process.platform === 'win32'; }

  start() {
    if (this.proc || !this.available()) return;
    const file = path.join(os.tmpdir(), 'casnt-helper.ps1');
    fs.writeFileSync(file, '﻿' + PS_SCRIPT, 'utf8');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error)); }
        } catch (_) { /* ignore */ }
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('helper stopped')); }
      this.pending.clear();
    });
  }

  call(cmd, args = {}, timeoutMs = 8000) {
    if (!this.available()) return Promise.reject(new Error('Windows only'));
    this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timed out')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async press(spec, hold = 60, repeat = 1) {
    const vks = parseKeys(spec);
    for (let i = 0; i < Math.max(1, repeat); i++) await this.call('keys', { vks, hold });
  }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); this.proc = null; } }
}

module.exports = { WinHelper, parseKeys, PS_SCRIPT };
