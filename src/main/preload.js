'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startScraping: (config) => ipcRenderer.send('job:start', config),
  stopScraping: () => ipcRenderer.send('job:stop'),

  // removeAllListeners avant (re)souscription : évite la fuite de listeners
  // à chaque ré-abonnement (changement d'onglet, relance d'écoute).
  onLog: (callback) => {
    ipcRenderer.removeAllListeners('log');
    ipcRenderer.on('log', (event, data) => callback(data));
  },
  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('progress');
    ipcRenderer.on('progress', (event, data) => callback(data));
  },
  onStatusChange: (callback) => {
    ipcRenderer.removeAllListeners('status');
    ipcRenderer.on('status', (event, data) => callback(data));
  },

  analyzeMarket: (data) => ipcRenderer.invoke('market:analyze', data),
  analyzeGlobalDataset: (data) => ipcRenderer.invoke('globalai:analyze', data),

  onSchedulerTrigger: (callback) => {
    ipcRenderer.removeAllListeners('scheduler:trigger');
    ipcRenderer.on('scheduler:trigger', (event, data) => callback(data));
  },
  addSchedule: (task) => ipcRenderer.invoke('scheduler:add', task),
  removeSchedule: (id) => ipcRenderer.invoke('scheduler:remove', id),
  listSchedules: () => ipcRenderer.invoke('scheduler:list'),

  getHistory: () => ipcRenderer.invoke('job:getHistory'),
  deleteJob: (jobId) => ipcRenderer.invoke('job:delete', jobId),

  openFolder: (pathStr) => ipcRenderer.invoke('file:openFolder', pathStr),
  openFile: (pathStr) => ipcRenderer.invoke('file:openFile', pathStr),
  openExternal: (urlStr) => ipcRenderer.invoke('shell:openExternal', urlStr),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
});