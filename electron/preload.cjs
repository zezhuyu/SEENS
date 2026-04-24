// Minimal preload — exposes nothing sensitive, just marks the context as Electron
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('__electron__', { isElectron: true });
