# Contexto para seguir con «Editor Video Ace»

Pega este archivo (o pídele a Claude que lo lea en `C:\Editor Video\CONTEXTO-PARA-CLAUDE.md`) al empezar un chat nuevo.
Actualizado: 2 de noviembre de 2026.

## Quién y para qué

- Usuario en español. Graba salidas en bici (MTB) con una **Insta360 Ace Pro 2** en 4K, **montada boca abajo**, y registra la actividad
  con un **iGPSport** (FIT y GPX).
- Trabaja en un PC de sobremesa con Windows y una **RTX 2060** (pcviferor-jose, usuario `Usuario`). Usa también una **tablet Android**
  y un portátil.
- Exporta en horizontal. Quiere algo sencillo: highlights automáticos, datos del FIT sobre el vídeo al estilo de la app de Insta360,
  sincronización tipo Garmin VIRB y música.
- Objetivo actual: hacer el proyecto entero desde la tablet y dejar el PC solo para exportar.

## Dónde está

- Proyecto en el PC: `C:\Editor Video`. El editor es una app de escritorio (no web).
- Datos de la app: `%APPDATA%\Editor Video Ace` (proxies, `analisis\` con cachés, `tablet.json` con clave/puerto/arranque automático,
  `sesion-recuperada.evproj`).
- Proyectos creados desde la tablet: `Documentos\Editor Video Ace`. Lo subido desde la tablet: `Vídeos\Editor Video Ace\Desde la tablet\…`.
- Proyecto real del usuario: `C:\Users\Usuario\Downloads\Bicicleta_de_montaña_matutina (1).evproj` (16 clips VID_20260328_*.mp4
  en `D:\DCIM\Camera01`, la tarjeta) con su FIT `Bicicleta_de_montaña_matutina (1).fit` (57,3 km).
- Carpetas conectadas al chat anterior: `C:\Editor Video`, `C:\Users\Usuario\AppData\Roaming\Editor Video Ace`,
  `C:\Users\Usuario\Downloads`, `D:\DCIM\Camera01` (esta última no se monta en el shell del puente; usar list/stage).

## Cómo se arranca y se distribuye

- Icono del escritorio → `Iniciar.vbs`: si `package.json` es más nuevo que `node_modules\.package-lock.json` hace `npm install`;
  luego `npx vite build` (registro a un log temporal que se copia a `inicio.log`; si falla y existe `dist`, avisa y abre la versión
  anterior) y lanza `node_modules\electron\dist\electron.exe`. Sin consola. **Cada arranque compila el código actual.**
- `Iniciar (con consola).bat` para ver errores; `Instalar.bat` (npm install + acceso directo); `CrearAccesoDirecto.bat`.
- `CrearInstalador.bat` → `npm run dist` → `release\Editor-Video-Ace-Instalador-0.1.0.exe` (NSIS, para el portátil; el nombre no
  cambia entre versiones). ffprobe va en `extraResources` (`resources/bin/ffprobe.exe`), ffmpeg-static con `asarUnpack`.
- **Solo una copia abierta** (`requestSingleInstanceLock`): si se abre otra, se trae al frente y avisa de cerrar para cargar novedades.
- Las funciones de la tablet no se han probado todavía en la versión instalada (empaquetada).

## Pila técnica

Electron 44 + Vite 7 + TypeScript (DOM sin framework). FFmpeg (ffmpeg-static, build gyan con NVENC en Windows) y ffprobe-static,
@garmin/fitsdk, Leaflet (OSM + satélite Esri), qrcode. Unas 7.900 líneas.

```
electron/main.cjs          proceso principal: protocolo media:// (rangos + lista de permitidos), diálogos, IPC, cachés,
                           servidor de la tablet, una sola instancia
electron/ffmpeg.cjs        probe (con rotación), encoders, proxies (cuda→gpu→cpu), analyze (movimiento+audio por s),
                           audioLevels (dB cada 0,25 s), runExport (2 fases)
electron/music.cjs         BPM, pulsos y compases
electron/tabletServer.cjs  servidor HTTP en la wifi para la tablet
electron/preload.cjs       window.api
src/renderer/store.ts      estado del proyecto, sincronización (deshacer), línea de tiempo (deshacer), música, guardar/abrir,
                           autoguardado, reenlazar archivos que faltan, cola de proxies
src/renderer/syncView.ts   pestaña Sincronizar (mapa Navegar/Ajustar, ±0,1/±1 s, «Solo este clip», comprobación)
src/renderer/syncCheck.ts  comprobar sincronización: correlación sonido del viento ↔ velocidad del FIT
src/renderer/editView.ts   biblioteca, vista previa, línea de tiempo, carril de música, transiciones
src/renderer/overlay*.ts   widgets de datos (número, indicador, barra, gráfica, perfil, minimapa, reloj) y plantillas
src/renderer/highlights*.ts highlights automáticos (+ ajuste a la música)
src/renderer/projectDialog.ts ventanas «Proyecto nuevo» y «Abrir» (vídeos / carpeta / vacío / proyecto / recientes)
src/renderer/musicDialog.ts, transitionsDialog.ts, exportDialog.ts, player.ts, telemetry.ts, util.ts, types.ts
src/renderer/tabletData.ts editor de datos de la tablet (pantalla completa: tocar/arrastrar/esquina/pellizco, chips, deshacer)
src/renderer/tablet.ts/.html/.css, tabletApi.ts (window.api por HTTP), tabletFiles.ts (explorador y subidas),
                           tabletLink.ts (lado PC: estado, órdenes, ofertas de archivos, diálogo con QR)
```

## Funciones hechas (todas probadas en el contenedor)

- **Clips**: arrastrar y soltar; proxies 540p en segundo plano (o el `LRV_*.lrv` de la cámara directamente); vídeos boca abajo
  corregidos (matriz rotate 180; la clave del proxy incluye la rotación).
- **FIT/GPX** + **sincronización**: automática por hora de cámara (prueba zona horaria y si la marca es de inicio o fin); mapa con
  🎯 Ajustar (tocar la ruta = este fotograma está aquí) y 🧭 Navegar (tocar la ruta = ir a ese fotograma); desfase común +
  ajuste propio por clip; deshacer/rehacer; tras el primer ajuste en el mapa (`mapSynced`), si un ajuste nuevo cambia ≥0,3 s
  pregunta «Solo este clip / A todos»; la leyenda marca «ajuste propio», «⚠ parece desfasado ±X s» o «✓ cuadra».
- **¿Está bien sincronizado?** (bajo el vídeo de Sincronizar): gráfica velocidad (naranja) vs sonido (azul) y
  «🔍 Comprobar todos los clips» con «Corregir» por clip o del desfase común. Busca ±20 s; fiabilidad alta/media/baja; con
  velocidad casi constante dice «No se puede saber». Validado: detectó +3,0 s exactos en un clip sintético hecho con el FIT real.
  Con el clip real 210 (subida a 7–9 km/h) sale dudoso, como debe.
- **Datos sobre el vídeo**: widgets editables, plantillas (Completo, Minimalista, Puerto de montaña, MTB + propias).
- **Highlights**: duración total libre, rango por hora o km, duración de cada momento, variedad de zonas, ajuste a la música
  (cortes en pulso/compás, corte al cambiar de canción).
- **Música**: varias canciones, marcar/ordenar/recortar, volúmenes y fundido.
- **Transiciones**: varias (xfade), centradas en el corte; fundido inicial/final.
- **Exportar**: dos fases (piezas una a una para no agotar memoria, luego concat + datos + música), NVENC si hay.
- **Proyectos**: «Nuevo» abre una ventana (nombre + empezar con vídeos, con una carpeta —escanea 2 niveles de subcarpetas y
  coge el FIT/GPX que haya, preguntando si hay varios— o vacío) y lo guarda ya en `Documentos\Editor Video Ace`; «Abrir» permite
  un proyecto, vídeos, una carpeta o un reciente (últimos 8 en localStorage); «Guardar como…» (Ctrl+Mayús+S) pasa a trabajar en
  la copia; Ctrl+N. Antes «Nuevo» vaciaba sin más y parecía no hacer nada (no se reprodujo fallo real).
  Autoguardado una vez con nombre, recuperación de sesión, reabre el último, reenlaza archivos movidos.
- **Tablet** (Chrome en la misma wifi, `http://<ip-del-PC>:8765/?k=<clave>`):
  - La clave y el puerto se guardan (la dirección no cambia); opción «compartir siempre al abrir el editor»; «🔑 Cambiar la clave».
  - 📁 Proyecto: abrir, recientes (los manda el PC en `recents`), guardar con otro nombre y proyecto nuevo «Desde una carpeta del PC»
    (orden `newFrom`: explorador en modo carpeta, `scanMedia`, carga el FIT/GPX si hay uno; con varios, la tablet pregunta),
    «Elegir vídeos» o «Vacío». 📊 Datos abre el editor dato a dato (mientras se arrastra, `dataEditing.dragging` evita que el
    estado del PC lo pise). Probado con Electron, incluido el pellizco con eventos táctiles de CDP.
  - Botones: 📁 Proyecto (nuevo/abrir/renombrar, cargar FIT), 🎞 Clips (añadir de carpetas del PC o subir desde la tablet, al
    montaje, quitar), 🗺 Sincro (la misma vista que el PC), ⇅ Archivos (bajar cualquier archivo del PC / subir a la carpeta del PC
    abierta), ✨ Highlights, 🎵 Música, ⧉ Transic., 📊 Datos (plantillas), ⇪ Exportar (en el PC), ⛶ pantalla completa (recordada)
    y ⤢ solo el vídeo.
  - El vídeo exportado aparece en la tablet con «⬇ Descargar»; desde el PC, «📤 Enviar archivos a la tablet…».
  - Diagnóstico: el diálogo del PC muestra si la tablet llega, si tiene el proyecto y sus errores.

## Cómo trabajaba Claude (para seguir igual)

- Código en el contenedor (`/home/claude/ev`), `npx tsc --noEmit -p . && npx vite build`, pruebas y después copia al PC:
  copiar los archivos cambiados a `/mnt/user-data/outputs/ev/...`, `device_commit_files` (force) a `C:\Editor Video\...` y
  **verificar siempre con md5sum** en el shell del puente (una vez llegó una copia antigua sin avisar).
- Pruebas de punta a punta con Electron bajo `xvfb-run`: el editor real del PC (`require('/home/claude/ev/electron/main.cjs')`
  con `app.setPath` a carpetas de prueba) y una segunda `BrowserWindow` como tablet, llamando a `/api/command`, pulsando botones
  y leyendo el `.evproj` guardado. Vídeos sintéticos con ffmpeg (`testsrc2`, `creation_time`).
- Archivos `.vbs`/`.bat`: CRLF y cp1252.
- El usuario no ve las rutas del contenedor: hablarle en castellano, sin jerga, y decirle siempre que cierre el editor y lo abra
  desde el icono (y recargue la tablet) para tener los cambios.

## Pendiente / ideas

- El usuario aún no ha confirmado en su equipo real: la comprobación de sincronización, la pregunta «Solo este clip», el
  iniciador nuevo, la pantalla completa ni las transferencias de archivos.
- Tocar el mapa con el dedo en la tablet no se pudo probar automáticamente (es el mismo código que en el PC).
- «📤 Enviar archivos a la tablet…» no probado (abre el diálogo de Windows); usa el mismo aviso que el vídeo exportado (sí probado).
- Probar la tablet con la versión instalada (`CrearInstalador.bat`).
- Próximas ideas: plantillas propias desde la tablet (ahora solo las incluidas; las propias viven en el localStorage del PC);
  retocar la línea de tiempo con el dedo.
- Recomendado al usuario: reservar la IP del PC en el router para que la dirección de la tablet no cambie nunca.
