# Crea el acceso directo "Editor Video Ace" en el escritorio con el icono del editor.
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'build\icon.ico'
$custom = Join-Path $root 'icono.ico'
if (Test-Path $custom) { $icon = $custom }   # icono personalizado si existe
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Editor Video Ace.lnk'))
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $root 'Iniciar.vbs') + '"'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$icon,0"
$lnk.Description = 'Editor de vídeo para Insta360 con datos FIT/GPX'
$lnk.Save()
Write-Host "Acceso directo creado en el escritorio con el icono $icon"
