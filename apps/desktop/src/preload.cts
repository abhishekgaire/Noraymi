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
  readers: (): Promise<{ name: string; serial: string }[]> => ipcRenderer.invoke("west4:readers"),
  badge: {
    /** A tap on the reader: the tag's URL with its SUN message. Returns the unsubscribe. */
    onTap: (listener: (tap: { url: string; reader: string }) => void): (() => void) => {
      const handler = (_event: unknown, tap: { url: string; reader: string }) => listener(tap);
      ipcRenderer.on("west4:badge-tap", handler);
      return () => ipcRenderer.removeListener("west4:badge-tap", handler);
    },
    onReaders: (listener: (list: { name: string; serial: string }[]) => void): (() => void) => {
      const handler = (_event: unknown, list: { name: string; serial: string }[]) => listener(list);
      ipcRenderer.on("west4:readers", handler);
      return () => ipcRenderer.removeListener("west4:readers", handler);
    },
    /** Pairing, step one: hold the next tag presented and give its UID. */
    pairStart: (): Promise<{ uid: string }> => ipcRenderer.invoke("west4:badge:pair-start"),
    /** Pairing, step two: program the held tag with its keys; resolves with its first SUN message. */
    pairFinish: (plan: {
      host: string;
      meta_read_key: string;
      file_read_key: string;
      key_version: number;
    }): Promise<{ uid: string; url: string }> =>
      ipcRenderer.invoke("west4:badge:pair-finish", plan),
    cancelPair: (): Promise<void> => ipcRenderer.invoke("west4:badge:cancel"),
    fakeTap: (uid: string): Promise<void> => ipcRenderer.invoke("west4:badge:fake-tap", uid),
  },
  /** The USB printers this computer hosts, and raw ESC/POS to one of them (M3-14). */
  printers: (): Promise<{ name: string; serial: string }[]> => ipcRenderer.invoke("west4:printers"),
  print: (serial: string, base64: string): Promise<void> =>
    ipcRenderer.invoke("west4:print", serial, base64),
  fakePlug: (plugged: boolean): Promise<void> =>
    ipcRenderer.invoke("west4:printer:fake-plug", plugged),
  venue: {
    configure: (clock: {
      time_zone: string;
      day_cutover: string;
      server_time: string;
    }): Promise<void> => ipcRenderer.invoke("west4:venue", clock),
  },
});
