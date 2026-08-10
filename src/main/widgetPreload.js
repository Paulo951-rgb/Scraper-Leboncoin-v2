'use strict';

/**
 * Preload dédié au widget flottant.
 * N'expose que le strict minimum nécessaire au widget (progression/statut/fermeture),
 * en respectant contextIsolation + sandbox (pas de nodeIntegration).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('widget:progress');
    ipcRenderer.on('widget:progress', (event, data) => callback(data));
  },
  onStatus: (callback) => {
    ipcRenderer.removeAllListeners('widget:status');
    ipcRenderer.on('widget:status', (event, data) => callback(data));
  },
  close: () => ipcRenderer.send('widget:close'),
});
