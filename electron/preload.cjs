// Minimal preload — exposes nothing sensitive, just marks the context as Electron
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__electron__', {
  isElectron: true,
  resizeWindow: (w, h) => ipcRenderer.invoke('resize-window', w, h),
  getWindowSize: ()    => ipcRenderer.invoke('get-window-size'),
});
