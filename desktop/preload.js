const { contextBridge, ipcRenderer } = require("electron");

// The setup page gets exactly these three calls and nothing else - it is the
// only page the app loads from disk, and it must not gain broader privileges
// than the remote dashboard it hands over to.
contextBridge.exposeInMainWorld("setupApi", {
  testConnection: (connection) => ipcRenderer.invoke("test-connection", connection),
  saveConnection: (connection) => ipcRenderer.invoke("save-connection", connection),
  getConnection: () => ipcRenderer.invoke("get-connection"),
  listProfiles: () => ipcRenderer.invoke("list-profiles"),
});
