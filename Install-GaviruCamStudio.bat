@echo off
title Gaviru E400D Cam Studio - Full PC Setup & Auto-Installer
color 0B
setlocal EnableDelayedExpansion

echo ============================================================================
echo        GAVIRU E400D CAM STUDIO - FULL SOFTWARE INSTALLER (ANY PC)
echo ============================================================================
echo.

set "SRC_DIR=%~dp0"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\GaviruCamStudio"

echo [1/5] Checking Node.js runtime on this PC...
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo       Node.js not found! Automatically downloading and installing Node.js LTS...
    where winget >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    ) else (
        echo       Downloading official Node.js 64-bit Windows Installer (.msi)...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
          "$ProgressPreference = 'SilentlyContinue'; " ^
          "$msi = Join-Path $env:TEMP 'nodejs-lts-x64.msi'; " ^
          "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile $msi; " ^
          "Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn', '/norestart' -Wait; " ^
          "Remove-Item $msi -ErrorAction SilentlyContinue"
    )
    set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
    echo       [OK] Node.js installation step completed.
) else (
    for /f "delims=" %%v in ('node -v') do echo       [OK] Node.js is already installed (%%v).
)

echo.
echo [2/5] Installing Gaviru E400D Cam Studio to:
echo       "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

if exist "%SRC_DIR%GaviruCamStudio.exe" (
    copy /Y "%SRC_DIR%GaviruCamStudio.exe" "%INSTALL_DIR%\GaviruCamStudio.exe" >nul
    echo       [OK] Copied standalone GaviruCamStudio.exe
)
if exist "%SRC_DIR%camera-config.json" (
    if not exist "%INSTALL_DIR%\camera-config.json" (
        copy /Y "%SRC_DIR%camera-config.json" "%INSTALL_DIR%\camera-config.json" >nul
    )
)
copy /Y "%~f0" "%INSTALL_DIR%\Install-GaviruCamStudio.bat" >nul
if exist "%SRC_DIR%Start-GaviruCamStudio.bat" (
    copy /Y "%SRC_DIR%Start-GaviruCamStudio.bat" "%INSTALL_DIR%\Start-GaviruCamStudio.bat" >nul
)

echo.
echo [3/5] Configuring Windows Firewall for Canon Wi-Fi PTP/IP & OBS Studio...
netsh advfirewall firewall delete rule name="Gaviru E400D Cam Studio" >nul 2>nul
netsh advfirewall firewall add rule name="Gaviru E400D Cam Studio" dir=in action=allow program="%INSTALL_DIR%\GaviruCamStudio.exe" enable=yes >nul 2>nul
netsh advfirewall firewall add rule name="Gaviru E400D Cam Studio HTTP" dir=in action=allow protocol=TCP localport=8080 >nul 2>nul
echo       [OK] Firewall rules configured.

echo.
echo [4/5] Creating Desktop & Start Menu Shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$target = if (Test-Path '%INSTALL_DIR%\GaviruCamStudio.exe') { '%INSTALL_DIR%\GaviruCamStudio.exe' } else { '%SRC_DIR%GaviruCamStudio.exe' }; " ^
  "$workDir = Split-Path $target; " ^
  "$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gaviru E400D Cam Studio.lnk'; " ^
  "$s1 = $ws.CreateShortcut($desktopLnk); " ^
  "$s1.TargetPath = $target; " ^
  "$s1.WorkingDirectory = $workDir; " ^
  "$s1.Description = 'Gaviru E400D Cam Studio — Canon Wi-Fi Live View & OBS Studio'; " ^
  "$s1.IconLocation = 'shell32.dll,16'; " ^
  "$s1.Save(); " ^
  "$startMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Gaviru E400D Cam Studio.lnk'; " ^
  "$s2 = $ws.CreateShortcut($startMenuLnk); " ^
  "$s2.TargetPath = $target; " ^
  "$s2.WorkingDirectory = $workDir; " ^
  "$s2.Description = 'Gaviru E400D Cam Studio — Canon Wi-Fi Live View & OBS Studio'; " ^
  "$s2.IconLocation = 'shell32.dll,16'; " ^
  "$s2.Save();"
echo       [OK] Desktop shortcut "Gaviru E400D Cam Studio" created!

echo.
echo [5/5] Launching Gaviru E400D Cam Studio...
echo ============================================================================
echo   Installation Complete! You can now open "Gaviru E400D Cam Studio"
echo   anytime directly from your Desktop!
echo ============================================================================
echo.

if exist "%INSTALL_DIR%\GaviruCamStudio.exe" (
    start "" /D "%INSTALL_DIR%" "%INSTALL_DIR%\GaviruCamStudio.exe"
) else if exist "%SRC_DIR%GaviruCamStudio.exe" (
    start "" /D "%SRC_DIR%" "%SRC_DIR%GaviruCamStudio.exe"
)

timeout /t 4 >nul
exit /b 0
