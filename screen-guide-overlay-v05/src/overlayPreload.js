const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayBridge', {
  onUpdate: (callback) => ipcRenderer.on('overlay:update', (_event, payload) => callback(payload)),
  openUrl: (url) => ipcRenderer.invoke('guide:open-url', url),
  notifyNavigated: () => ipcRenderer.invoke('guide:overlay-navigated')
});
