# input-helper.ps1
#
# Long-lived helper process: reads one JSON object per line from stdin and
# turns it into real mouse/keyboard input via the classic Win32 mouse_event /
# keybd_event APIs. These take plain numeric arguments (no structs to marshal),
# which sidesteps the struct-layout pitfalls of the newer SendInput API.
# Launched and fed by agent.js.
#
# Expected JSON line shapes (matching what public/index.html sends):
#   {"type":"mousemove","x":960,"y":540}                  // absolute, pre-pointer-lock
#   {"type":"mousemove_relative","dx":5,"dy":-3}           // relative, pointer-lock mode
#   {"type":"mousedown","x":960,"y":540,"button":0}        // 0=left,1=middle,2=right
#   {"type":"mouseup","x":960,"y":540,"button":0}
#   {"type":"mousedown_relative","button":0}
#   {"type":"mouseup_relative","button":0}
#   {"type":"wheel","deltaY":120}
#   {"type":"keydown","key":"a","code":"KeyA"}
#   {"type":"keyup","key":"a","code":"KeyA"}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class Win32Input {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@

$SM_CXSCREEN = 0
$SM_CYSCREEN = 1
$screenW = [Win32Input]::GetSystemMetrics($SM_CXSCREEN)
$screenH = [Win32Input]::GetSystemMetrics($SM_CYSCREEN)

$REMOTE_W = 1920
$REMOTE_H = 1080

function Move-Absolute($x, $y) {
    # SetCursorPos takes real screen pixel coordinates directly -- simplest
    # possible absolute-move call, no normalization needed.
    $realX = [int](($x / $REMOTE_W) * $screenW)
    $realY = [int](($y / $REMOTE_H) * $screenH)
    [Win32Input]::SetCursorPos($realX, $realY) | Out-Null
}

function Move-Relative($dx, $dy) {
    [Win32Input]::mouse_event([Win32Input]::MOUSEEVENTF_MOVE, [int]$dx, [int]$dy, 0, 0)
}

function Mouse-Button($button, $down) {
    switch ($button) {
        0 { $flag = if ($down) { [Win32Input]::MOUSEEVENTF_LEFTDOWN } else { [Win32Input]::MOUSEEVENTF_LEFTUP } }
        1 { $flag = if ($down) { [Win32Input]::MOUSEEVENTF_MIDDLEDOWN } else { [Win32Input]::MOUSEEVENTF_MIDDLEUP } }
        2 { $flag = if ($down) { [Win32Input]::MOUSEEVENTF_RIGHTDOWN } else { [Win32Input]::MOUSEEVENTF_RIGHTUP } }
        default { return }
    }
    [Win32Input]::mouse_event($flag, 0, 0, 0, 0)
}

function Mouse-Wheel($deltaY) {
    # Browser wheel deltaY is "pixels down"; Windows wheel data is in multiples
    # of 120 and positive means "up/away from the user", so invert the sign.
    $amount = [int](-$deltaY)
    [Win32Input]::mouse_event([Win32Input]::MOUSEEVENTF_WHEEL, 0, 0, $amount, 0)
}

function Send-Key($vk, $down) {
    $flags = if ($down) { 0 } else { [Win32Input]::KEYEVENTF_KEYUP }
    [Win32Input]::keybd_event([byte]$vk, 0, $flags, 0)
}

# Map JS KeyboardEvent.code values to Windows virtual-key codes.
# Extend this table as needed for keys you actually use.
$codeToVk = @{
    "KeyA"=0x41;"KeyB"=0x42;"KeyC"=0x43;"KeyD"=0x44;"KeyE"=0x45;"KeyF"=0x46;
    "KeyG"=0x47;"KeyH"=0x48;"KeyI"=0x49;"KeyJ"=0x4A;"KeyK"=0x4B;"KeyL"=0x4C;
    "KeyM"=0x4D;"KeyN"=0x4E;"KeyO"=0x4F;"KeyP"=0x50;"KeyQ"=0x51;"KeyR"=0x52;
    "KeyS"=0x53;"KeyT"=0x54;"KeyU"=0x55;"KeyV"=0x56;"KeyW"=0x57;"KeyX"=0x58;
    "KeyY"=0x59;"KeyZ"=0x5A;
    "Digit0"=0x30;"Digit1"=0x31;"Digit2"=0x32;"Digit3"=0x33;"Digit4"=0x34;
    "Digit5"=0x35;"Digit6"=0x36;"Digit7"=0x37;"Digit8"=0x38;"Digit9"=0x39;
    "Enter"=0x0D;"Escape"=0x1B;"Backspace"=0x08;"Tab"=0x09;"Space"=0x20;
    "ShiftLeft"=0xA0;"ShiftRight"=0xA1;"ControlLeft"=0xA2;"ControlRight"=0xA3;
    "AltLeft"=0xA4;"AltRight"=0xA5;
    "ArrowLeft"=0x25;"ArrowUp"=0x26;"ArrowRight"=0x27;"ArrowDown"=0x28;
    "Delete"=0x2E;"Home"=0x24;"End"=0x23;"PageUp"=0x21;"PageDown"=0x22;
    "F1"=0x70;"F2"=0x71;"F3"=0x72;"F4"=0x73;"F5"=0x74;"F6"=0x75;
    "F7"=0x76;"F8"=0x77;"F9"=0x78;"F10"=0x79;"F11"=0x7A;"F12"=0x7B;
    "Minus"=0xBD;"Equal"=0xBB;"BracketLeft"=0xDB;"BracketRight"=0xDD;
    "Semicolon"=0xBA;"Quote"=0xDE;"Comma"=0xBC;"Period"=0xBE;"Slash"=0xBF;
    "Backslash"=0xDC;"CapsLock"=0x14;
}

Write-Host "input-helper.ps1 ready ($screenW x $screenH)"

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { Start-Sleep -Milliseconds 50; continue }
    if ($line.Trim().Length -eq 0) { continue }

    try {
        $evt = $line | ConvertFrom-Json
    } catch {
        Write-Host "[input-helper] bad JSON line: $line"
        continue
    }

    Write-Host "[input-helper] received: $($evt.type) x=$($evt.x) y=$($evt.y) dx=$($evt.dx) dy=$($evt.dy)"

    switch ($evt.type) {
        "mousemove"           { Move-Absolute $evt.x $evt.y }
        "mousedown"           { Move-Absolute $evt.x $evt.y; Mouse-Button $evt.button $true }
        "mouseup"             { Move-Absolute $evt.x $evt.y; Mouse-Button $evt.button $false }
        "mousemove_relative"  { Move-Relative $evt.dx $evt.dy }
        "mousedown_relative"  { Mouse-Button $evt.button $true }
        "mouseup_relative"    { Mouse-Button $evt.button $false }
        "wheel"               { Mouse-Wheel $evt.deltaY }
        "keydown"             { if ($codeToVk.ContainsKey($evt.code)) { Send-Key $codeToVk[$evt.code] $true } }
        "keyup"               { if ($codeToVk.ContainsKey($evt.code)) { Send-Key $codeToVk[$evt.code] $false } }
    }
}
