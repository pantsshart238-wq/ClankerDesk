Add-Type -AssemblyName System.Drawing

function New-ClankerIcon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = "AntiAliasGridFit"
  $g.Clear([System.Drawing.Color]::FromArgb(255, 13, 20, 32))
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 74, 138, 255), [System.Drawing.Color]::FromArgb(255, 24, 61, 128), 90)
  $pad = [int]($size * 0.035)
  $w = $size - 2 * $pad
  $inner = New-Object System.Drawing.Rectangle($pad, $pad, $w, $w)
  $rad = [int]($size * 0.20)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($inner.X, $inner.Y, $rad * 2, $rad * 2, 180, 90)
  $p.AddArc($inner.Right - $rad * 2, $inner.Y, $rad * 2, $rad * 2, 270, 90)
  $p.AddArc($inner.Right - $rad * 2, $inner.Bottom - $rad * 2, $rad * 2, $rad * 2, 0, 90)
  $p.AddArc($inner.X, $inner.Bottom - $rad * 2, $rad * 2, $rad * 2, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brush, $p)
  $font = New-Object System.Drawing.Font("Segoe UI", ([float]($size * 0.50)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = "Center"
  $fmt.LineAlignment = "Center"
  $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 0, 0, 0))
  $r1 = New-Object System.Drawing.RectangleF(0.0, ([float]($size * 0.03)), ([float]$size), ([float]$size))
  $r2 = New-Object System.Drawing.RectangleF(0.0, 0.0, ([float]$size), ([float]$size))
  $g.DrawString("C", $font, $shadow, $r1, $fmt)
  $g.DrawString("C", $font, [System.Drawing.Brushes]::White, $r2, $fmt)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $p.Dispose(); $brush.Dispose(); $font.Dispose(); $fmt.Dispose(); $shadow.Dispose()
}

New-ClankerIcon 512 "public\icon-512.png"
New-ClankerIcon 192 "public\icon-192.png"
New-ClankerIcon 64  "public\favicon.png"
"icons written"
