@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-windows.ps1" -Action doctor
set "company_result=%errorlevel%"
if not "%company_result%"=="0" if not defined CI pause
exit /b %company_result%
