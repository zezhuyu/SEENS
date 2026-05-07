// Minimal preload — exposes nothing sensitive, just marks the context as Electron
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__electron__', {
  isElectron: true,
  resizeWindow: (w, h) => ipcRenderer.invoke('resize-window', w, h),
  getWindowSize: ()    => ipcRenderer.invoke('get-window-size'),
  setTrayStatus: (status) => ipcRenderer.send('set-tray-status', status),
  // Tray play/pause control
  onTrayTogglePlay: (cb) => ipcRenderer.on('tray-toggle-play', cb),
  onTraySkipNext:   (cb) => ipcRenderer.on('tray-skip-next', cb),
  reportPlayState:  (playing) => ipcRenderer.send('tray-play-state', playing),
});
