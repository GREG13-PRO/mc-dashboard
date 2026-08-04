const { contextBridge, ipcRenderer } = require("electron");

// The setup page gets exactly these calls and nothing else - it is the only
// page the app loads from disk, and it must not gain broader privileges than
// the remote dashboard it hands over to. pickFolder opens the system dialog in
// the main process rather than handing the page any filesystem access.
contextBridge.exposeInMainWorld("setupApi", {
  testConnection: (connection) => ipcRenderer.invoke("test-connection", connection),
  saveConnection: (connection) => ipcRenderer.invoke("save-connection", connection),
  getConnection: () => ipcRenderer.invoke("get-connection"),
  listProfiles: () => ipcRenderer.invoke("list-profiles"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  createLocal: (options) => ipcRenderer.invoke("create-local", options),
});
