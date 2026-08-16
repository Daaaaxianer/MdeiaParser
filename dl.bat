@echo off
chcp 65001 >nul
title Media Parser CLI
cd /d "%~dp0"
node cli.js %*
pause
