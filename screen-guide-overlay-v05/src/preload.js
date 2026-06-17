const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenGuide', {
  analyzeFrame: (payload) => ipcRenderer.invoke('guide:analyze-frame', payload),
  getPageState: () => ipcRenderer.invoke('guide:get-page-state'),
  clearOverlay: () => ipcRenderer.invoke('guide:clear-overlay'),
  showOverlay: (guidance) => ipcRenderer.invoke('guide:show-overlay', guidance),
  startWorkflow: (id) => ipcRenderer.invoke('guide:start-workflow', id),
  pauseWorkflow: (paused) => ipcRenderer.invoke('guide:pause-workflow', paused),
  stopWorkflow: () => ipcRenderer.invoke('guide:stop-workflow'),
  onPageStateUpdate: (cb) => ipcRenderer.on('page-state:update', (_e, data) => cb(data)),
  onWorkflowStepChange: (cb) => ipcRenderer.on('workflow:step-change', (_e, data) => cb(data)),
  onWorkflowStatusChange: (cb) => ipcRenderer.on('workflow:status-change', (_e, data) => cb(data)),
  onRedetect: (cb) => ipcRenderer.on('guide:redetect', () => cb()),
  onNavigate: (cb) => ipcRenderer.on('guide:navigate', (_e, data) => cb(data)),
  openUrl: (url) => ipcRenderer.invoke('guide:open-url', url)
});
