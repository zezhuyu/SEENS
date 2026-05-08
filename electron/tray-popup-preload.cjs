const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__tray__', {
  sendChat:      (msg) => ipcRenderer.invoke('tray-popup-chat', msg),
  playTrack:     (idx) => ipcRenderer.invoke('tray-popup-play', idx),
  togglePlay:    ()    => ipcRenderer.send('tray-popup-toggle-play'),
  onQueueUpdate: (cb)  => ipcRenderer.on('queue-update', (_e, q) => cb(q)),
  onPlayState:   (cb)  => ipcRenderer.on('popup-play-state', (_e, p) => cb(p)),
});
