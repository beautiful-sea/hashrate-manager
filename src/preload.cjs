const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("hashrate", {
  invoke: (action, payload) => ipcRenderer.invoke("manager", action, payload),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
});
