// The narrow bridge between the staff app and the desktop shell (M1-28).
// Sandboxed, so plain CommonJS and nothing but these calls: the renderer never
// sees Node.js. Every call is checked again in the main process by its sender.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("west4", {
  desktop: true,
  version: (): Promise<string> => ipcRenderer.invoke("west4:version"),
  token: {
    get: (): Promise<string | null> => ipcRenderer.invoke("west4:token:get"),
    set: (token: string): Promise<void> => ipcRenderer.invoke("west4:token:set", token),
    clear: (): Promise<void> => ipcRenderer.invoke("west4:token:clear"),
  },
  venue: {
    configure: (clock: {
      time_zone: string;
      day_cutover: string;
      server_time: string;
    }): Promise<void> => ipcRenderer.invoke("west4:venue", clock),
  },
});
