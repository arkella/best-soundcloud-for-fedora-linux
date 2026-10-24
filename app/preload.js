const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  nav: {
    home: () => ipcRenderer.invoke('nav:home')
  },
  ui: {
    togglePanel: (panelName) => ipcRenderer.invoke('ui:toggle-panel', panelName),
    pickWallpaperFile: () => ipcRenderer.invoke('ui:pick-wallpaper')
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    reportSize: (width, height) => ipcRenderer.send('window:report-size', { width, height })
  },
  controls: {
    getSettings: () => ipcRenderer.invoke('app:get-settings'),
    saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch)
  },
  geniusSearch: (payload) => ipcRenderer.invoke('genius:search', payload),
  onSettingsUpdated: (callback) => {
    ipcRenderer.on('app:settings-updated', (_event, data) => callback(data));
  }
});
