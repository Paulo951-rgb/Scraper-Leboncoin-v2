'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startScraping: (config) => ipcRenderer.send('job:start', config),
  stopScraping: () => ipcRenderer.send('job:stop'),

  onLog: (callback) => ipcRenderer.on('log', (event, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('progress', (event, data) => callback(data)),
  onStatusChange: (callback) => ipcRenderer.on('status', (event, data) => callback(data)),

  analyzeMarket: (data) => ipcRenderer.invoke('market:analyze', data),

  onSchedulerTrigger: (callback) => ipcRenderer.on('scheduler:trigger', (event, data) => callback(data)),
  addSchedule: (task) => ipcRenderer.invoke('scheduler:add', task),
  removeSchedule: (id) => ipcRenderer.invoke('scheduler:remove', id),
  listSchedules: () => ipcRenderer.invoke('scheduler:list'),

  getHistory: () => ipcRenderer.invoke('job:getHistory'),
  deleteJob: (jobId) => ipcRenderer.invoke('job:delete', jobId),

  openFolder: (pathStr) => ipcRenderer.invoke('file:openFolder', pathStr),
  openFile: (pathStr) => ipcRenderer.invoke('file:openFile', pathStr),
});