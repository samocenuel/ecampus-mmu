# Generates the eCampus app icon and Play Store graphics (Windows PowerShell + System.Drawing).
#   powershell -ExecutionPolicy Bypass -File tool\make_icons.ps1
# Then: dart run flutter_launcher_icons
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'assets\icon'
$storeDir = Join-Path $root 'store'
New-Item -ItemType Directory -Force $iconDir, $storeDir | Out-Null

$dark = [Drawing.Color]::FromArgb(255, 8, 74, 56)    # #084A38
$light = [Drawing.Color]::FromArgb(255, 18, 128, 92)  # #12805C
$gold = [Drawing.Color]::FromArgb(255, 247, 181, 41)  # #F7B529

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object Drawing.Bitmap $w, $h, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.InterpolationMode = 'HighQualityBicubic'
  return @($bmp, $g)
}

function Fill-Background($g, [int]$w, [int]$h) {
  $rect = New-Object Drawing.Rectangle 0, 0, $w, $h
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, $light, $dark, 45
  $g.FillRectangle($brush, $rect)
}

# The mark: a bold "e" wearing a graduation cap, centred on (cx, cy) with overall size s.
function Draw-Mark($g, [float]$cx, [float]$cy, [float]$s) {
  $white = [Drawing.Brushes]::White
  # Lay the "e" out as a path so it can be positioned by its exact glyph bounds.
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $family = New-Object Drawing.FontFamily 'Segoe UI'
  $path.AddString('e', $family, [int][Drawing.FontStyle]::Bold, ($s * 0.95), (New-Object Drawing.PointF 0, 0), [Drawing.StringFormat]::GenericTypographic)
  $b = $path.GetBounds()
  $eHeight = $s * 0.56
  $scale = $eHeight / $b.Height
  $m = New-Object Drawing.Drawing2D.Matrix
  $m.Translate(($cx - $b.Width * $scale / 2), ($cy + $s * 0.5 - $eHeight))
  $m.Scale($scale, $scale)
  $m.Translate(-$b.X, -$b.Y)
  $path.Transform($m)
  $g.FillPath($white, $path)

  # Mortarboard top (diamond) and cap, resting on the "e".
  $top = $cy - $s * 0.5
  $w = $s * 0.86; $h = $s * 0.28
  $diamond = [Drawing.PointF[]]@(
    (New-Object Drawing.PointF $cx, $top),
    (New-Object Drawing.PointF ($cx + $w / 2), ($top + $h / 2)),
    (New-Object Drawing.PointF $cx, ($top + $h)),
    (New-Object Drawing.PointF ($cx - $w / 2), ($top + $h / 2))
  )
  $capW = $s * 0.42
  $cap = [Drawing.PointF[]]@(
    (New-Object Drawing.PointF ($cx - $capW / 2), ($top + $h * 0.55)),
    (New-Object Drawing.PointF ($cx + $capW / 2), ($top + $h * 0.55)),
    (New-Object Drawing.PointF ($cx + $capW / 2), ($top + $h * 1.15)),
    (New-Object Drawing.PointF $cx, ($top + $h * 1.32)),
    (New-Object Drawing.PointF ($cx - $capW / 2), ($top + $h * 1.15))
  )
  $g.FillPolygon($white, $cap)
  $g.FillPolygon($white, $diamond)
  # Gold tassel.
  $pen = New-Object Drawing.Pen $gold, ($s * 0.022)
  $tx = $cx + $w * 0.36
  $g.DrawLine($pen, $cx, ($top + $h / 2), $tx, ($top + $h * 0.62))
  $g.DrawLine($pen, $tx, ($top + $h * 0.62), $tx, ($top + $h * 1.35))
  $g.FillEllipse((New-Object Drawing.SolidBrush $gold), ($tx - $s * 0.035), ($top + $h * 1.30), ($s * 0.07), ($s * 0.09))
}

function Save($bmp, $path) { $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output "wrote $path" }

# 1. Full launcher icon (iOS / legacy Android / web): square, opaque.
$c = New-Canvas 1024 1024; Fill-Background $c[1] 1024 1024; Draw-Mark $c[1] 512 540 760; Save $c[0] (Join-Path $iconDir 'icon.png')

# 2. Adaptive icon foreground: transparent, mark inside the 66% safe zone.
$c = New-Canvas 1024 1024; Draw-Mark $c[1] 512 540 470; Save $c[0] (Join-Path $iconDir 'icon_foreground.png')

# 3. Play Store hi-res icon 512x512.
$c = New-Canvas 512 512; Fill-Background $c[1] 512 512; Draw-Mark $c[1] 256 270 380; Save $c[0] (Join-Path $storeDir 'play-icon-512.png')

# 4. Play Store feature graphic 1024x500.
$c = New-Canvas 1024 500; $g = $c[1]; Fill-Background $g 1024 500
Draw-Mark $g 230 262 330
$title = New-Object Drawing.Font 'Segoe UI', 74, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
$sub = New-Object Drawing.Font 'Segoe UI', 30, ([Drawing.FontStyle]::Regular), ([Drawing.GraphicsUnit]::Pixel)
$dot = [char]0x00B7
$g.DrawString('eCampus MMU', $title, [Drawing.Brushes]::White, 420, 150)
$g.FillRectangle((New-Object Drawing.SolidBrush $gold), 432, 258, 110, 6)
$g.DrawString("Timetables  $dot  Attendance  $dot  Reminders", $sub, (New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(235, 255, 255, 255))), 426, 282)
Save $c[0] (Join-Path $storeDir 'feature-graphic-1024x500.png')
