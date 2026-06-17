const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayBridge', {
  onUpdate: (callback) => ipcRenderer.on('overlay:update', (_event, payload) => callback(payload))
});
