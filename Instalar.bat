@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo No se encuentra Node.js. Instalalo desde https://nodejs.org y vuelve a ejecutar este archivo. & pause & exit /b 1)
echo Instalando dependencias, puede tardar unos minutos...
call npm install
if errorlevel 1 (echo. & echo Hubo un error en la instalacion. & pause & exit /b 1)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\acceso-directo.ps1"
echo.
echo Listo. Abre el editor con el icono "Editor Video Ace" del escritorio.
pause
