' Abre Editor Video Ace sin dejar ninguna ventana de consola abierta.
Option Explicit
Dim sh, fso, dir, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

If Not fso.FolderExists(dir & "\node_modules\electron\dist") Then
  MsgBox "Primero ejecuta Instalar.bat.", vbExclamation, "Editor Video Ace"
  WScript.Quit 1
End If

' Si han cambiado las dependencias (package.json más nuevo que la última instalación), se instalan antes.
Dim pj, lock
Set pj = fso.GetFile(dir & "\package.json")
If fso.FileExists(dir & "\node_modules\.package-lock.json") Then
  Set lock = fso.GetFile(dir & "\node_modules\.package-lock.json")
  If pj.DateLastModified > lock.DateLastModified Then
    code = sh.Run("cmd /c npm install > instalacion.log 2>&1", 0, True)
    If code <> 0 Then
      MsgBox "No se pudieron instalar las novedades." & vbCrLf & "Ejecuta Instalar.bat para ver el error.", vbCritical, "Editor Video Ace"
      WScript.Quit 1
    End If
    ' marcar la instalación como hecha (para no repetirla en cada arranque)
    sh.Run "cmd /c copy /b node_modules\.package-lock.json +,, node_modules\.package-lock.json >nul", 0, True
  End If
End If

' Prepara la interfaz (recoge los últimos cambios del código). Oculto y esperando a que termine.
' El registro se escribe primero en un archivo propio de este arranque (así nunca choca con uno bloqueado)
' y luego se copia a inicio.log.
Dim tmpLog
Randomize
tmpLog = sh.ExpandEnvironmentStrings("%TEMP%") & "\editor-video-ace-inicio-" & CStr(Int(Rnd * 1000000)) & ".log"
code = sh.Run("cmd /c npx vite build > """ & tmpLog & """ 2>&1", 0, True)
On Error Resume Next
fso.CopyFile tmpLog, dir & "\inicio.log", True
If Err.Number <> 0 Then
  Err.Clear
  fso.CopyFile tmpLog, dir & "\inicio-ultimo.log", True
End If
fso.DeleteFile tmpLog, True
On Error GoTo 0
If code <> 0 Then
  If fso.FileExists(dir & "\dist\index.html") Then
    MsgBox "No se pudieron preparar las novedades del editor (el detalle está en inicio.log)." & vbCrLf & vbCrLf & _
      "Se abre la versión anterior. Si el editor ya estaba abierto, ciérralo y vuelve a abrirlo.", vbExclamation, "Editor Video Ace"
  Else
    MsgBox "No se pudo preparar el editor." & vbCrLf & "Revisa el archivo inicio.log de la carpeta del editor.", vbCritical, "Editor Video Ace"
    WScript.Quit 1
  End If
End If

' Lanza la aplicación y termina este lanzador.
sh.Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 1, False
