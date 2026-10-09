const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cue', {
  platform: process.platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  ask: (payload) => ipcRenderer.send('ask', payload),
  assistToggle: () => ipcRenderer.invoke('assist:toggle'),
  captureToggle: () => ipcRenderer.invoke('capture:toggle'),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (payload) => ipcRenderer.send('mic:pcm', payload),
  systemPcm: (payload) => ipcRenderer.send('system:pcm', payload),
  audioDrained: (payload) => ipcRenderer.send('audio:drained', payload),
  audioStatus: (payload) => ipcRenderer.send('audio:status', payload),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  hideToTray: () => ipcRenderer.send('window:hide-to-tray'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'audio:status', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'llm:idle', 'status', 'transcript', 'settings:open'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
