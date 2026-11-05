<#
  Attaches / detaches a window to the desktop wallpaper layer (WorkerW).
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File desktop-pin.ps1 -Hwnd <int64> -Action attach
    powershell ... -Action detach
  Prints: OK <workerwHwnd> <originX> <originY>   (physical pixels, DPI aware)
#>
param(
  [Parameter(Mandatory = $true)][long]$Hwnd,
  [Parameter(Mandatory = $true)][ValidateSet('attach', 'detach')][string]$Action,
  [long]$DeskHost = 0
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DzmPin {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    public const int GWL_STYLE = -16;
    public const uint WS_CHILD = 0x40000000;
    public const uint WS_VISIBLE = 0x10000000;
    public const uint WS_POPUP = 0x80000000;
    public const uint WS_CAPTION = 0x00C00000;
    public const uint WS_THICKFRAME = 0x00040000;
}
'@

[void][DzmPin]::SetProcessDpiAwarenessContext([IntPtr](-4))

$child = [IntPtr]$Hwnd
if (-not [DzmPin]::IsWindow($child)) {
  Write-Error "invalid hwnd $Hwnd"
  exit 1
}

if ($Action -eq 'detach') {
  $rect = New-Object DzmPin+RECT
  [void][DzmPin]::GetWindowRect($child, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $style = [DzmPin]::GetWindowLongPtr($child, [DzmPin]::GWL_STYLE).ToInt64()
  $style = ($style -band (-bnot 0x40000000)) -bor 0x80000000 -bor 0x10000000
  [void][DzmPin]::SetWindowLongPtr($child, [DzmPin]::GWL_STYLE, [IntPtr]$style)
  [void][DzmPin]::SetParent($child, [IntPtr]::Zero)
  # Restore the same on-screen rect now that coordinates are screen based again
  [void][DzmPin]::SetWindowPos($child, [IntPtr]::Zero, $rect.Left, $rect.Top, $width, $height, 0x0034)
  Write-Output ("OK 0 0 0 rect={0},{1},{2},{3}" -f $rect.Left, $rect.Top, $width, $height)
  exit 0
}

$nullStr = [NullString]::Value
$progman = [DzmPin]::FindWindow("Progman", $nullStr)
if ($progman -eq [IntPtr]::Zero) {
  Write-Error "Progman not found"
  exit 1
}

# Ask Explorer to spawn the wallpaper host window when no host can be found
$result = [IntPtr]::Zero

# The wallpaper layer is a large top-level WorkerW; small WorkerW helpers must be ignored
$screenW = [DzmPin]::GetSystemMetrics(0)
$screenH = [DzmPin]::GetSystemMetrics(1)

function Test-Large([IntPtr]$h) {
  $rect = New-Object DzmPin+RECT
  [void][DzmPin]::GetClientRect($h, [ref]$rect)
  return (($rect.Right - $rect.Left) -ge ($screenW * 0.5)) -and (($rect.Bottom - $rect.Top) -ge ($screenH * 0.5))
}

function Resolve-Target {
  $script:preferred = [IntPtr]::Zero
  $script:anyWorker = [IntPtr]::Zero
  $callback = [DzmPin+EnumWindowsProc]{
    param([IntPtr]$top, [IntPtr]$param)
    $defView = [DzmPin]::FindWindowEx($top, [IntPtr]::Zero, "SHELLDLL_DefView", $nullStr)
    if ($defView -ne [IntPtr]::Zero) {
      $candidate = [DzmPin]::FindWindowEx([IntPtr]::Zero, $top, "WorkerW", $nullStr)
      if ($candidate -ne [IntPtr]::Zero -and (Test-Large $candidate) -and [DzmPin]::IsWindowVisible($candidate) -and $script:preferred -eq [IntPtr]::Zero) {
        $script:preferred = $candidate
      }
    }
    $cls = New-Object System.Text.StringBuilder 64
    [void][DzmPin]::GetClassName($top, $cls, 64)
    if ($cls.ToString() -eq 'WorkerW' -and (Test-Large $top) -and [DzmPin]::IsWindowVisible($top) -and $script:anyWorker -eq [IntPtr]::Zero) {
      $script:anyWorker = $top
    }
    return $true
  }
  [void][DzmPin]::EnumWindows($callback, [IntPtr]::Zero)
  if ($script:preferred -ne [IntPtr]::Zero) { return $script:preferred }
  return $script:anyWorker
}

$script:target = [IntPtr]::Zero
if ($DeskHost -ne 0) {
  $cached = [IntPtr]$DeskHost
  if ([DzmPin]::IsWindow($cached) -and [DzmPin]::IsWindowVisible($cached)) {
    $cachedCls = New-Object System.Text.StringBuilder 64
    [void][DzmPin]::GetClassName($cached, $cachedCls, 64)
    $name = $cachedCls.ToString()
    if ($name -eq 'WorkerW' -or $name -eq 'Progman') { $script:target = $cached }
  }
}
if ($script:target -eq [IntPtr]::Zero) { $script:target = Resolve-Target }
if ($script:target -eq [IntPtr]::Zero) {
  [void][DzmPin]::SendMessageTimeout($progman, 0x052C, [IntPtr]0xD, [IntPtr]::Zero, 0, 2000, [ref]$result)
  Start-Sleep -Milliseconds 150
  $script:target = Resolve-Target
}
if ($script:target -eq [IntPtr]::Zero) { $script:target = $progman }

$rect = New-Object DzmPin+RECT
[void][DzmPin]::GetWindowRect($child, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

$styleValue = [DzmPin]::GetWindowLongPtr($child, [DzmPin]::GWL_STYLE).ToInt64()
$newStyle = ($styleValue -band (-bnot 0x80000000) -band (-bnot 0x00C00000) -band (-bnot 0x00040000))
$newStyle = $newStyle -bor 0x40000000 -bor 0x10000000

function Restore-TopLevel {
  $cur = [DzmPin]::GetWindowLongPtr($child, [DzmPin]::GWL_STYLE).ToInt64()
  $cur = ($cur -band (-bnot 0x40000000)) -bor 0x80000000 -bor 0x10000000
  [void][DzmPin]::SetWindowLongPtr($child, [DzmPin]::GWL_STYLE, [IntPtr]$cur)
  [void][DzmPin]::SetParent($child, [IntPtr]::Zero)
  [void][DzmPin]::SetWindowPos($child, [IntPtr]::Zero, $rect.Left, $rect.Top, $width, $height, 0x0034)
  [void][DzmPin]::ShowWindow($child, 4)
}

[void][DzmPin]::SetWindowLongPtr($child, [DzmPin]::GWL_STYLE, [IntPtr]$newStyle)

[void][DzmPin]::SetParent($child, $script:target)

$origin = New-Object DzmPin+POINT
$origin.X = 0
$origin.Y = 0
[void][DzmPin]::ClientToScreen($script:target, [ref]$origin)

# Keep the same on-screen position after becoming a child window
[void][DzmPin]::SetWindowPos($child, [IntPtr]::Zero, ($rect.Left - $origin.X), ($rect.Top - $origin.Y), $width, $height, 0x0034)
[void][DzmPin]::ShowWindow($child, 4)

$parent = [DzmPin]::GetParent($child)
if ($parent -ne $script:target) {
  Restore-TopLevel
  Write-Error "attach failed: parent=$($parent.ToInt64()) target=$($script:target.ToInt64())"
  exit 2
}
if (-not [DzmPin]::IsWindowVisible($child)) {
  Restore-TopLevel
  Write-Error "attach failed: child window not visible"
  exit 3
}
$vis = if ([DzmPin]::IsWindowVisible($child)) { 1 } else { 0 }
Write-Output ("OK {0} {1} {2} parent={3} vis={4} child={5}x{6}" -f $script:target.ToInt64(), $origin.X, $origin.Y, $parent.ToInt64(), $vis, $width, $height)
