@echo off
rem ============================================
rem  Media Parser launcher (ASCII only, safe on
rem  any Windows code page). All Chinese text is
rem  printed by start.ps1 (UTF-8 with BOM).
rem ============================================
chcp 65001 >nul
title Media Parser - Batch Watermark-Free Downloader
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell not found. This tool requires Windows.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
