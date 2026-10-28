@echo off
title Gaviru E400D Cam - Studio Web Control Panel
cd /d "%~dp0"
echo Stopping any old server on port 8787...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul
set "CAM_IP=%~1"
if "%CAM_IP%"=="" (
    echo.
    echo ==============================================================
    echo   GAVIRU E400D CAM STUDIO - CANON 4000D LIVE VIEW
    echo ==============================================================
    echo Common Canon IPs:
    echo   - 192.168.1.2   : Camera Direct AP Wi-Fi Mode
    echo   - 192.168.1.145 : Home Router / Saved Default IP
    echo.
    set /p "CAM_IP=Enter Canon Camera IP (press ENTER to use saved/auto IP): "
)

echo ==============================================================
echo   Starting Gaviru E400D Cam Studio Web Control Panel...
echo   Control Panel : http://127.0.0.1:8787/control
echo   OBS Stream    : http://127.0.0.1:8787/stream
echo ==============================================================
start "" "http://127.0.0.1:8787/control"

if not "%CAM_IP%"=="" (
    echo Connecting to Camera IP: %CAM_IP%
    bun run dev -- --camera-ip %CAM_IP% --listen-host 0.0.0.0 --serve-mjpeg
) else (
    bun src/main.ts
)
pause
