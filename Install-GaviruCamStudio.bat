@echo off
title Gaviru E400D Cam Studio - Full PC Setup & Auto-Installer
color 0B
setlocal EnableDelayedExpansion

echo ============================================================================
echo        GAVIRU E400D CAM STUDIO - FULL SOFTWARE INSTALLER (ANY PC)
echo        Owner: Gaviru Sandeeptha - Canon EOS 4000D Studio Suite
echo ============================================================================
echo.

set "SRC_DIR=%~dp0"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\GaviruCamStudio"

echo [1/4] Preparing installation directory:
echo       "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

taskkill /F /IM GaviruCamStudio.exe >nul 2>nul
timeout /t 1 /nobreak >nul

echo.
echo [2/4] Installing GaviruCamStudio.exe & Files...
if exist "%SRC_DIR%GaviruCamStudio.exe" (
    copy /Y "%SRC_DIR%GaviruCamStudio.exe" "%INSTALL_DIR%\GaviruCamStudio.exe" >nul
    echo       [OK] Installed GaviruCamStudio.exe
) else if exist "%SRC_DIR%GaviruCamStudio-Full-Software\GaviruCamStudio.exe" (
    copy /Y "%SRC_DIR%GaviruCamStudio-Full-Software\GaviruCamStudio.exe" "%INSTALL_DIR%\GaviruCamStudio.exe" >nul
    echo       [OK] Installed GaviruCamStudio.exe
)

if exist "%SRC_DIR%assets\gaviru-cam.ico" (
    copy /Y "%SRC_DIR%assets\gaviru-cam.ico" "%INSTALL_DIR%\gaviru-cam.ico" >nul
) else if exist "%SRC_DIR%gaviru-cam.ico" (
    copy /Y "%SRC_DIR%gaviru-cam.ico" "%INSTALL_DIR%\gaviru-cam.ico" >nul
)

if not exist "%INSTALL_DIR%\camera-config.json" (
    (
        echo {
        echo   "cameraIp": "192.168.1.145",
        echo   "cameraPort": 15740,
        echo   "listenHost": "0.0.0.0",
        echo   "listenPort": 8787,
        echo   "autoDiscover": true
        echo }
    ) > "%INSTALL_DIR%\camera-config.json"
)

copy /Y "%~f0" "%INSTALL_DIR%\Install-GaviruCamStudio.bat" >nul
if exist "%SRC_DIR%Start-GaviruCamStudio.bat" (
    copy /Y "%SRC_DIR%Start-GaviruCamStudio.bat" "%INSTALL_DIR%\Start-GaviruCamStudio.bat" >nul
)
if exist "%SRC_DIR%start-studio.bat" (
    copy /Y "%SRC_DIR%start-studio.bat" "%INSTALL_DIR%\start-studio.bat" >nul
)

echo.
echo [3/4] Configuring Windows Firewall for Canon Wi-Fi & OBS Port 8787...
netsh advfirewall firewall delete rule name="Gaviru E400D Cam Studio" >nul 2>nul
netsh advfirewall firewall add rule name="Gaviru E400D Cam Studio" dir=in action=allow program="%INSTALL_DIR%\GaviruCamStudio.exe" enable=yes >nul 2>nul
netsh advfirewall firewall add rule name="Gaviru E400D Cam Studio HTTP" dir=in action=allow protocol=TCP localport=8787 >nul 2>nul
echo       [OK] Windows Firewall rules configured.

echo.
echo [4/4] Creating Desktop & Start Menu Shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$target = '%INSTALL_DIR%\GaviruCamStudio.exe'; " ^
  "$workDir = '%INSTALL_DIR%'; " ^
  "$icon = if (Test-Path '%INSTALL_DIR%\gaviru-cam.ico') { '%INSTALL_DIR%\gaviru-cam.ico,0' } else { 'shell32.dll,16' }; " ^
  "$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gaviru E400D Cam Studio.lnk'; " ^
  "$s1 = $ws.CreateShortcut($desktopLnk); " ^
  "$s1.TargetPath = $target; " ^
  "$s1.WorkingDirectory = $workDir; " ^
  "$s1.Description = 'Gaviru E400D Cam Studio — Canon Wi-Fi Live View & OBS Studio'; " ^
  "$s1.IconLocation = $icon; " ^
  "$s1.Save(); " ^
  "$startMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Gaviru E400D Cam Studio.lnk'; " ^
  "$s2 = $ws.CreateShortcut($startMenuLnk); " ^
  "$s2.TargetPath = $target; " ^
  "$s2.WorkingDirectory = $workDir; " ^
  "$s2.Description = 'Gaviru E400D Cam Studio — Canon Wi-Fi Live View & OBS Studio'; " ^
  "$s2.IconLocation = $icon; " ^
  "$s2.Save();"
echo       [OK] Desktop shortcut 'Gaviru E400D Cam Studio' created!

echo.
echo ============================================================================
echo   Installation Complete! Launching Gaviru E400D Cam Studio...
echo   Desktop Shortcut created: Gaviru E400D Cam Studio.lnk
echo ============================================================================
echo.

if exist "%INSTALL_DIR%\GaviruCamStudio.exe" (
    start "" /D "%INSTALL_DIR%" "%INSTALL_DIR%\GaviruCamStudio.exe"
)

timeout /t 3 >nul
exit /b 0
