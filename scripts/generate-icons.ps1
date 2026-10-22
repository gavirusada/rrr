Add-Type -AssemblyName System.Drawing

function Create-AppIcon([int]$size, [string]$outFile) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Background circle
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 11, 15, 25))
    $g.FillEllipse($bgBrush, 2, 2, $size - 4, $size - 4)

    # Red/Gold outer ring
    $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 239, 68, 68), [Math]::Max(4, [int]($size * 0.045)))
    $g.DrawEllipse($ringPen, [int]($size * 0.05), [int]($size * 0.05), [int]($size * 0.9), [int]($size * 0.9))

    # Camera body (Rounded rectangle)
    $camW = [int]($size * 0.62)
    $camH = [int]($size * 0.44)
    $camX = [int](($size - $camW) / 2)
    $camY = [int](($size - $camH) / 2 + ($size * 0.04))
    $camBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 28, 33, 45))
    $g.FillRectangle($camBrush, $camX, $camY, $camW, $camH)

    # Top viewfinder bump
    $vfW = [int]($camW * 0.38)
    $vfH = [int]($size * 0.12)
    $vfX = [int](($size - $vfW) / 2)
    $vfY = [int]($camY - $vfH + 2)
    $g.FillRectangle($camBrush, $vfX, $vfY, $vfW, $vfH)

    # Lens Outer Circle
    $lensD = [int]($camH * 0.92)
    $lensX = [int](($size - $lensD) / 2)
    $lensY = [int]($camY + ($camH - $lensD) / 2)
    $lensRingPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 245, 158, 11), [Math]::Max(2, [int]($size * 0.035)))
    $g.DrawEllipse($lensRingPen, $lensX, $lensY, $lensD, $lensD)

    # Lens Inner Glass
    $glassD = [int]($lensD * 0.72)
    $glassX = [int](($size - $glassD) / 2)
    $glassY = [int]($lensY + ($lensD - $glassD) / 2)
    $glassBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 6, 182, 212))
    $g.FillEllipse($glassBrush, $glassX, $glassY, $glassD, $glassD)

    # Lens Reflection
    $refPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 255, 255, 255), [Math]::Max(1, [int]($size * 0.02)))
    $g.DrawArc($refPen, $glassX + [int]($glassD * 0.15), $glassY + [int]($glassD * 0.15), [int]($glassD * 0.7), [int]($glassD * 0.7), 210, 80)

    # Red Recording Dot
    $dotD = [int]($size * 0.08)
    $dotX = [int]($camX + $camW - $dotD - ($size * 0.04))
    $dotY = [int]($camY + ($size * 0.04))
    $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 239, 68, 68))
    $g.FillEllipse($dotBrush, $dotX, $dotY, $dotD, $dotD)

    $g.Dispose()
    $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "Saved: $outFile ($size x $size)"
}

Create-AppIcon 192 "assets/icon-192.png"
Create-AppIcon 512 "assets/icon-512.png"
Create-AppIcon 192 "GaviruCamStudio-Full-Software/icon-192.png"
Create-AppIcon 512 "GaviruCamStudio-Full-Software/icon-512.png"
