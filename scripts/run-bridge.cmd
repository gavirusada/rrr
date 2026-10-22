@echo off
setlocal
cd /d "%~dp0.."
call bun run build:node
if errorlevel 1 exit /b %errorlevel%
node dist\main.js --serve-mjpeg %*
