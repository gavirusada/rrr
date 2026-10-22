@echo off
title Gaviru E400D Cam - Studio Web Control Panel
cd /d "%~dp0"
echo Stopping any old server on port 8787...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul
echo ==============================================================
echo   Starting Gaviru E400D Cam Studio Web Control Panel...
echo   Control Panel : http://127.0.0.1:8787/control
echo   OBS Stream    : http://127.0.0.1:8787/stream
echo ==============================================================
start "" "http://127.0.0.1:8787/control"
bun run dev -- --camera-ip 192.168.1.145 --listen-host 0.0.0.0 --serve-mjpeg
pause
