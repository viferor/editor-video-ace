@echo off
cd /d "%~dp0"
if not exist node_modules (echo Primero ejecuta Instalar.bat & pause & exit /b 1)
echo Creando el instalador de Editor Video Ace...
echo (la primera vez tarda unos minutos porque descarga las herramientas de empaquetado)
echo.
call npm run dist
if errorlevel 1 (
  echo.
  echo No se pudo crear el instalador.
  echo Si el error habla de "symbolic link" o de un "privilegio", cierra esta ventana y
  echo ejecuta este archivo como administrador: clic derecho, "Ejecutar como administrador".
  pause
  exit /b 1
)
echo.
echo Listo. El instalador esta en la carpeta "release":
dir /b release\*.exe
explorer "%~dp0release"
pause
