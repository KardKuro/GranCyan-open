@echo off
rem Grancyan APK 一键构建（改完 Grancyan2.0.html 后双击这个即可重新打包）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
pause
