@echo off
title Gaviru Cam Mobile - React VDO.Ninja Broadcaster
color 0A
cd /d "%~dp0GaviruCam-React-Mobile"

echo ============================================================================
echo      GAVIRU CAM MOBILE - REACT VDO.NINJA BROADCASTER (NO PC NEEDED)
echo ============================================================================
echo.
echo [1/2] Starting React Mobile Server on local Wi-Fi...
echo.
echo   - Mobile Phone එකෙන් මෙම link එක Open කරන්න:
echo   - Local Wi-Fi: http://localhost:5173
echo.
echo [2/2] Opening browser preview...
start http://localhost:5173

bun run dev --host
if %ERRORLEVEL% NEQ 0 (
    npm run dev -- --host
)
pause
