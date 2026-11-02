# Editor Video Ace

Editor de vídeo para las grabaciones en bici con la **Insta360 Ace Pro 2**, con datos de la actividad
**FIT/GPX** (iGPSport) sincronizados con el vídeo.

## Instalación (una sola vez)

1. Instala **Node.js LTS** desde https://nodejs.org (opción por defecto, «Next» en todo).
2. Doble clic en **`Instalar.bat`**. Descarga las dependencias, FFmpeg incluido (unos minutos), y crea
   el acceso directo **Editor Video Ace** en el escritorio, con su icono.

## Uso diario

- Doble clic en el icono **Editor Video Ace** del escritorio, o en `Iniciar.bat`. No queda ninguna ventana
  de consola abierta. La ventana del editor tarda unos segundos en aparecer.
- Si algo falla al arrancar, sale un aviso. El detalle queda en `inicio.log`, o abre
  **`Iniciar (con consola).bat`** para ver los errores en directo.
- **Cambiar el icono**: pon tu propio archivo `icono.ico` en esta carpeta y ejecuta `CrearAccesoDirecto.bat`.
  Para cambiar también el de la ventana del editor, sustituye `build\icon.ico`.
- Para desarrollo con recarga en caliente: `npm run dev`.

## Llevarlo a otro ordenador (instalador)

1. En este PC, doble clic en **`CrearInstalador.bat`**. La primera vez tarda unos minutos. Al terminar se abre la
   carpeta `release` con **`Editor-Video-Ace-Instalador-0.1.0.exe`** (lleva todo dentro: no hace falta Node.js).
   Si da un error de «symbolic link» o «privilegio», ejecútalo como administrador (clic derecho).
2. Copia ese `.exe` al portátil (USB, nube…) y ejecútalo. Crea el icono en el escritorio y en el menú Inicio.
3. Copia también tus proyectos (`.evproj`). Al abrir uno, si los vídeos, las canciones o el FIT están en otra
   ruta, el editor pregunta en qué carpeta buscarlos, los encuentra por su nombre y guarda las rutas nuevas.
4. Las vistas fluidas se usan de los LRV de la cámara (o se generan una vez). Si el portátil no tiene gráfica
   NVIDIA, se exporta con el procesador (funciona igual, pero más lento).

## 📱 Revisar y retocar en la tablet

1. En el editor del PC pulsa **📱 Tablet**: aparece un código QR y la dirección (`http://<ip-del-pc>:8765/?k=…`).
2. Con la tablet en la **misma wifi**, escanea el QR (o escribe la dirección en Chrome). Opcional: menú de Chrome →
   «Añadir a pantalla de inicio» para abrirla como una app.
3. **📁 Proyecto**: crear un proyecto nuevo, abrir otro, cambiarle el nombre y cargar la actividad (FIT/GPX).
   Los proyectos creados desde la tablet se guardan en `Documentos\Editor Video Ace`.
   **🎞 Clips**: añadir vídeos (de cualquier carpeta del PC, p. ej. la tarjeta de la cámara, o **⬆ subidos desde
   la tablet**), ponerlos en la línea de tiempo o quitarlos. Lo que se sube desde la tablet se guarda en el PC en
   `Vídeos\Editor Video Ace\Desde la tablet`. En 🎵 Música también se pueden elegir o subir canciones.
   **🗺 Sincronizar**: la misma pantalla que en el PC (mapa con 🎯 Ajustar / 🧭 Navegar, ±0,1 s / ±1 s,
   «Solo este clip», auto-sincronizar, deshacer). Así el proyecto entero se puede hacer en la tablet y dejar
   el PC solo para exportar.
   **⇅ Archivos**: explorar las carpetas del PC para **bajar a la tablet** cualquier archivo (se guarda en las
   descargas de Chrome), o **subir desde la tablet** archivos a la carpeta del PC que tengas abierta. Cada vídeo
   exportado aparece en la tablet con un aviso «⬇ Descargar» (también en el diálogo de exportar). Desde el PC,
   en el diálogo 📱 Tablet, **📤 Enviar archivos a la tablet…** hace que salga ese aviso con los archivos que elijas.
4. En la tablet: ver el montaje con los datos y la música, mover/recortar/dividir/borrar momentos (↶ ↷),
   ✨ Highlights, 🎵 marcar/ordenar/recortar canciones, ⧉ transiciones, 📊 plantilla de datos y
   **⇪ Exportar en el PC** (se guarda en la carpeta Vídeos del PC; el progreso se ve en la tablet).
   **⛶ Pantalla completa** (arriba a la derecha): la app ocupa toda la pantalla, sin barras de Chrome ni de Android,
   y se recuerda (vuelve a ella con el primer toque al abrirla). **⤢** junto a la barra de reproducción muestra solo
   el vídeo con los datos a pantalla completa; «⤡ Salir» vuelve al editor.
5. Todo se sincroniza solo en los dos sentidos y se guarda en el proyecto del PC.

Notas: el PC debe estar encendido con el editor abierto. La primera vez Windows puede preguntar por el firewall:
permite el acceso en **redes privadas**. Los vídeos no se copian a la tablet: se ven las vistas fluidas (LRV/proxies)
del PC por la wifi (subir vídeos 4K por wifi tarda: mejor elegirlos de la tarjeta en el PC). «Dejar de compartir» corta el acceso.

**La dirección no cambia**: la clave y el puerto se guardan, así que basta con guardarla una vez en la tablet
(Chrome → ⋮ → «Añadir a pantalla de inicio»). Marca **«Compartir con la tablet siempre al abrir el editor»** para no
tener que pulsar nada en el PC. **🔑 Cambiar la clave** invalida la dirección antigua (tendrás que escanear el QR nuevo).
Para que tampoco cambie la IP del PC, reserva su IP en el router (DHCP estático) o fíjala en Windows.

## Flujo de trabajo

1. **Añadir clips**: los MP4 de la cámara. También puedes arrastrarlos a la ventana. Se generan
   *proxies* de 540p en segundo plano para que la vista previa vaya fluida. La barra azul muestra el progreso.
2. **Cargar FIT/GPX**: mejor el FIT, que trae todas las métricas. Se sincroniza solo usando la hora de
   grabación y detecta si la cámara guarda la hora local.
3. **Pestaña 1 · Sincronizar**: afina el desfase.
   - En modo **🎯 Ajustar sincronización**: pon el vídeo en un fotograma reconocible y **haz clic en ese punto de la ruta**.
   - Después el mapa pasa solo a **🧭 Navegar**: un clic en la ruta salta al clip y fotograma grabados en ese punto,
     para revisar la sincronización sin estropearla. Para volver a ajustar, pulsa 🎯 encima del mapa.
   - Ajuste fino con ±0,1 s / ±1 s (o Mayús + ← / →).
   - El desfase es común a todos los clips (mismo reloj de cámara). Marca «Solo este clip» si alguno va aparte.
   - Cada clip se pinta con su color sobre la ruta para comprobar que cae donde toca.
   - **¿Está bien sincronizado?** Bajo el vídeo, una gráfica con la velocidad de la actividad (naranja) y el nivel
     de sonido del vídeo (azul: el ruido del viento sube con la velocidad). Si las subidas, bajadas y paradas
     coinciden, el clip está bien. **🔍 Comprobar todos los clips** calcula para cada uno cuánto se desvía y con qué
     fiabilidad; «Corregir» le pone el ajuste propio. Si casi todos se desvían lo mismo, ofrece corregir el desfase
     común. En clips con velocidad casi constante no se puede saber (lo dice). La leyenda del mapa marca
     «⚠ parece desfasado» o «✓ cuadra».
   - **Deshacer / Rehacer** (Ctrl+Z / Ctrl+Y) cualquier cambio de sincronización. Los toques seguidos de ±0,1 s
     cuentan como un solo paso. «Quitar sincronización» vuelve a la hora de la cámara (también se puede deshacer).
4. **Pestaña 2 · Editar**: monta la línea de tiempo. Arrastra vídeos desde el Explorador de Windows:
   sobre la biblioteca se añaden, y sobre la línea de tiempo se insertan justo donde marca la línea naranja.
   - **✨ Highlights automáticos**: eliges la duración del resumen (libre, p. ej. 1:30), la parte de la salida
     (toda, entre dos horas o entre dos kilómetros), la duración de cada momento (la que quieras), la variedad de zonas y qué buscar (velocidad y bajadas, curvas, rampas y cimas, picos
     de esfuerzo, movimiento y sonido del vídeo). Con variedad alta los momentos se reparten por toda la ruta. Monta la línea de tiempo
     sola, en orden cronológico, evitando las paradas. Luego se retoca a mano como cualquier montaje.
   - **🎵 Música**: una lista de canciones (mp3, m4a, wav, flac…). En el selector puedes elegir varias a la vez
     (Ctrl o Mayús + clic). Cada una tiene su casilla para usarla o no, se puede reordenar (↑ ↓) y recortar
     (de / a). Suenan seguidas las marcadas. Se detecta el ritmo de cada una (BPM y compases) y aparecen como
     bloques de colores bajo la línea de tiempo con los compases marcados. Ajustes comunes: volumen de la
     música, volumen del sonido de la cámara y fundido final.
   - Con música, **Highlights** ofrece «Ajustar a la música»: el resumen dura lo mismo que las canciones
     marcadas, cada corte cae en un pulso/compás de su canción y siempre hay un corte al cambiar de canción.
   - **⧉ Transiciones**: corte seco, fundido cruzado, disolución, fundido a negro o a blanco, deslizar, barrido,
     círculo, zoom, radial o variadas; duración de 0,2 a 1,5 s y fundido desde/a negro al principio y al final.
     Se centran en cada corte (el vídeo dura lo mismo y con música siguen cayendo en el pulso). Se aplican al
     exportar; en la línea de tiempo se marcan con ◆.
   - **↶ / ↷** (Ctrl+Z / Ctrl+Y) deshacen y rehacen cualquier cambio en la línea de tiempo.
5. **Pestaña 3 · Datos**: los datos que se graban sobre el vídeo.
   - Tipos: número, indicador circular, barra, gráfica de los últimos segundos, perfil de altitud y minimapa.
   - Datos: velocidad, pulso, potencia, cadencia, altitud, pendiente, distancia, temperatura, hora y tiempo.
   - Arrastra para mover, esquina inferior derecha para cambiar el tamaño (Mayús: proporcional), imanes con
     los márgenes de seguridad y con los otros datos. A la derecha: fondo, letra, colores, opacidad, rangos…
   - **Plantillas**: incluidas (Completo, Minimalista, Puerto de montaña, MTB) y las tuyas propias.
   - Lo que ves en la vista previa es exactamente lo que sale en el vídeo exportado.
6. **Exportar**: desde los originales 4K, con la GPU NVIDIA (NVENC) si está disponible, con o sin los datos y la música.
   Se procesa un momento cada vez (sin agotar memoria aunque haya cientos) y después se unen; las piezas
   temporales se guardan junto al vídeo final y se borran al terminar.

## Atajos

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / pausa |
| S | Dividir en el cabezal |
| I / O | Recortar inicio / fin en el cabezal |
| Supr | Borrar segmento seleccionado |
| ← / → | Fotograma anterior / siguiente (Mayús: ±5 s) |
| Inicio / Fin | Ir al principio / final |
| 1 / 2 / 3 | Pestaña Sincronizar / Editar / Datos |
| Ctrl+S / Ctrl+Mayús+S | Guardar / Guardar como |
| Ctrl+O | Abrir proyecto |
| Ctrl+E | Exportar |
| , / . | (Sincronizar) fotograma anterior / siguiente |
| Ctrl+Z / Ctrl+Y | Deshacer / rehacer (sincronización en Sincronizar, montaje en Editar) |
| Supr, flechas | (Datos) quitar / mover el dato seleccionado (Mayús: más rápido) |

## Notas técnicas

- **Guardado automático**: el proyecto se guarda solo con cada cambio, una vez que le has dado nombre con Ctrl+S.
  Al abrir el editor se reabre el último proyecto. Si no le has dado nombre, el trabajo se conserva igualmente
  y se recupera la próxima vez.
- **Vídeos boca abajo**: se respeta la orientación que marca la cámara (como hace la app de Insta360).
- **Archivos LRV**: si junto al `VID_xxx.mp4` está el `LRV_xxx.lrv` que guarda la cámara, se usa como vista
  previa directamente (no hay que generar nada). Si no está, se genera un proxy.
- Los proxies se guardan en `%APPDATA%\Editor Video Ace\proxies`. Se hacen una sola vez por vídeo y se
  pueden borrar sin problema: se regeneran cuando hacen falta. Si cierras el editor mientras se genera uno,
  ese vuelve a empezar la próxima vez (los terminados se conservan).
- Los proyectos (`.evproj`) guardan las rutas de los vídeos y del FIT, no copias.
- Para usar otro FFmpeg, define las variables de entorno `FFMPEG_PATH` / `FFPROBE_PATH`.
- Mapas: OpenStreetMap y Esri World Imagery (satélite), para uso personal.

## Estructura

```
electron/main.cjs        proceso principal: diálogos, protocolo media://, IPC
electron/ffmpeg.cjs      análisis, proxies, detección de NVENC y exportación
electron/preload.cjs     puente seguro con la interfaz
electron/music.cjs       detección de ritmo (BPM, pulsos y compases)
electron/tabletServer.cjs servidor en la red local para la tablet
src/renderer/            interfaz (TypeScript + Vite)
  store.ts               estado del proyecto, auto-sincronización, guardar/abrir
  telemetry.ts           lectura FIT/GPX, interpolación, búsqueda de puntos en la ruta
  syncView.ts            pestaña de sincronización con mapa
  editView.ts            biblioteca, vista previa y línea de tiempo
  overlay.ts             motor de widgets de datos (vista previa y exportación)
  overlayView.ts         pestaña Datos: editor de widgets y plantillas
  player.ts              reproductor de la línea de tiempo
  highlights.ts          puntuación y selección automática de momentos (y cortes al ritmo)
  musicDialog.ts         lista de canciones y ajustes de música
  transitionsDialog.ts   transiciones entre momentos
  tabletLink.ts          (PC) compartir con la tablet: QR, estado y cambios
  tablet.ts / tablet.html / tabletApi.ts / tablet.css   app de la tablet
  tabletFiles.ts         (tablet) explorador de carpetas del PC y subida de archivos
  exportDialog.ts        diálogo de exportación (envía los datos a FFmpeg fotograma a fotograma)
```

## Próximas fases

- Editor de datos widget a widget en la tablet (ahora solo plantillas).
