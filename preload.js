const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sr', {
  usage: (ids) => ipcRenderer.invoke('usage', ids),
  usageDetail: (opts) => ipcRenderer.invoke('usageDetail', opts),
  pickFolder: (start) => ipcRenderer.invoke('pickFolder', start),
  badge: (n) => ipcRenderer.send('badge', n),
  open: (url) => ipcRenderer.send('open', url),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
