const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideos: () => ipcRenderer.invoke('dialog:openVideos'),
  openTelemetry: () => ipcRenderer.invoke('dialog:openTelemetry'),
  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  saveProjectDialog: (name) => ipcRenderer.invoke('dialog:saveProject', name),
  saveExportDialog: (name) => ipcRenderer.invoke('dialog:saveExport', name),
  confirm: (message, buttons) => ipcRenderer.invoke('dialog:confirm', message, buttons),

  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  writeText: (p, t) => ipcRenderer.invoke('fs:writeText', p, t),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openFolder: (title) => ipcRenderer.invoke('dialog:openFolder', title),
  findFiles: (dir, names) => ipcRenderer.invoke('fs:findFiles', dir, names),
  scanMedia: (dir) => ipcRenderer.invoke('fs:scanMedia', dir),

  probe: (p) => ipcRenderer.invoke('media:probe', p),
  proxy: (p, dur) => ipcRenderer.invoke('media:proxy', p, dur),
  encoders: () => ipcRenderer.invoke('media:encoders'),
  analyze: (p, dur) => ipcRenderer.invoke('media:analyze', p, dur),
  audioLevels: (p) => ipcRenderer.invoke('media:audioLevels', p),
  openMusic: () => ipcRenderer.invoke('dialog:openMusic'),
  openAny: (title) => ipcRenderer.invoke('dialog:openAny', title),
  onTabletStarted: (cb) => ipcRenderer.on('tablet:started', (_e, d) => cb(d)),
  onTabletTransfer: (cb) => ipcRenderer.on('tablet:transfer', (_e, d) => cb(d)),
  analyzeMusic: (p) => ipcRenderer.invoke('music:analyze', p),
  exportStart: (job) => ipcRenderer.invoke('export:start', job),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportFrame: (data) => ipcRenderer.invoke('export:frame', data),
  exportFramesEnd: () => ipcRenderer.invoke('export:framesEnd'),

  onProxyProgress: (cb) => ipcRenderer.on('proxy:progress', (_e, d) => cb(d)),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, d) => cb(d)),
  onBeforeClose: (cb) => ipcRenderer.on('app:before-close', () => cb()),
  closeConfirmed: () => ipcRenderer.invoke('app:close-confirmed'),
  recoveryPath: () => ipcRenderer.invoke('app:recoveryPath'),
  exportDefaultPath: (name) => ipcRenderer.invoke('export:defaultPath', name),
  tabletStart: () => ipcRenderer.invoke('tablet:start'),
  tabletStop: () => ipcRenderer.invoke('tablet:stop'),
  tabletInfo: () => ipcRenderer.invoke('tablet:info'),
  tabletSetAutoStart: (v) => ipcRenderer.invoke('tablet:setAutoStart', v),
  tabletNewKey: () => ipcRenderer.invoke('tablet:newKey'),
  tabletClients: () => ipcRenderer.invoke('tablet:clients'),
  tabletPush: (s) => ipcRenderer.send('tablet:state', s),
  onTabletApply: (cb) => ipcRenderer.on('tablet:apply', (_e, d) => cb(d)),
  onTabletExport: (cb) => ipcRenderer.on('tablet:export', (_e, d) => cb(d)),
  onTabletCommand: (cb) => ipcRenderer.on('tablet:command', async (_e, { id, cmd }) => {
    try { ipcRenderer.send('tablet:commandDone', { id, ok: true, result: (await cb(cmd)) ?? null }); }
    catch (e) { ipcRenderer.send('tablet:commandDone', { id, ok: false, error: String((e && e.message) || e) }); }
  }),
  projectPathFor: (name) => ipcRenderer.invoke('project:pathFor', name),

  mediaUrl: (p) => 'media://local/' + encodeURIComponent(p),
  pathForFile: (f) => webUtils.getPathForFile(f)
});
