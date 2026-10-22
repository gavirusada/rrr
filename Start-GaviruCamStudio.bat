@echo off
title Gaviru E400D Cam Studio Launcher
color 0A
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ============================================================================
echo               GAVIRU E400D CAM STUDIO - ONE-CLICK LAUNCHER
echo ============================================================================

:: 1. Ensure Node.js is installed on this PC if missing
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] Node.js is not installed on this PC. Installing Node.js LTS automatically...
    where winget >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
          "$ProgressPreference = 'SilentlyContinue'; " ^
          "$msi = Join-Path $env:TEMP 'nodejs-lts-x64.msi'; " ^
          "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile $msi; " ^
          "Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn', '/norestart' -Wait; " ^
          "Remove-Item $msi -ErrorAction SilentlyContinue"
    )
    set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
)

:: 2. Run the compiled standalone executable if present
if exist "%~dp0GaviruCamStudio.exe" (
    echo [OK] Starting GaviruCamStudio.exe...
    "%~dp0GaviruCamStudio.exe"
    exit /b %ERRORLEVEL%
)

:: 3. Fallback to Bun or Node/NPX if running from source folder
where bun >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    bun src/main.ts
    exit /b %ERRORLEVEL%
)

npx --yes tsx src/main.ts
