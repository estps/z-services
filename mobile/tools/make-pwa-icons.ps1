# Regenerates the PWA icons (z-192.png, z-180.png) in the z-chat-app repo
# from the 512x512 master, using .NET System.Drawing (Windows PowerShell 5.1).
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\make-pwa-icons.ps1
# Run from the z-services/mobile folder (or adjust -Source/-Dest below).

param(
  [string]$Source = "..\..\z-chat-app\public\icons\z-512.png",
  [string]$Dest = "..\..\z-chat-app\public\icons"
)

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source))
foreach ($size in @(180, 192)) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $out = Join-Path (Resolve-Path $Dest) "z-$size.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote $out"
}
$src.Dispose()
