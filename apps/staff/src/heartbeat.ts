import { ApiCallError } from "./api.js";
import { deviceRevoked, signedApi, type StoredDevice } from "./device.js";
import { startPrintHost } from "./print-host.js";

/**
 * A paired shared screen checks in every 30 seconds (M1-16, spec 09): its app
 * version, its clock, and the USB readers it can see (registered once each as
 * devices of their own, M1-30). The server raises the alert when a screen goes
 * quiet; the screen itself does nothing with the answer.
 */
export const HEARTBEAT_MS = 30_000;

const registered = new Map<string, string>();

/** A peripheral the host sees, registered once as a device of its own (M1-30 readers, M3-14 printers). */
export async function attachedId(
  device: StoredDevice,
  kind: "nfc_reader" | "printer",
  peripheral: { name: string; serial: string },
): Promise<string | null> {
  const key = `${kind}:${peripheral.serial}`;
  const known = registered.get(key);
  if (known) return known;
  try {
    const made = await signedApi<{ device_id: string }>(
      device,
      "POST",
      `/v1/venues/${device.venueId}/devices/attached`,
      { kind, name: peripheral.name, serial: peripheral.serial },
    );
    registered.set(key, made.device_id);
    return made.device_id;
  } catch {
    return null;
  }
}

/** The readers and USB printers the host can see right now: a printer that's unplugged drops out. */
async function attachedIds(device: StoredDevice): Promise<string[]> {
  const shell = typeof window === "undefined" ? undefined : window.west4;
  if (!shell) return [];
  const readers = await shell.readers().catch(() => []);
  const printers = shell.printers ? await shell.printers().catch(() => []) : [];
  const ids: string[] = [];
  for (const reader of readers) {
    const id = await attachedId(device, "nfc_reader", reader);
    if (id) ids.push(id);
  }
  for (const printer of printers) {
    const id = await attachedId(device, "printer", printer);
    if (id) ids.push(id);
  }
  return ids;
}

export async function heartbeat(device: StoredDevice): Promise<void> {
  const shell = typeof window === "undefined" ? undefined : window.west4;
  const version = shell ? await shell.version().catch(() => null) : null;
  await signedApi(device, "POST", "/v1/devices/heartbeat", {
    app_version: version ?? "web",
    clock: new Date().toISOString(),
    attached: await attachedIds(device),
  });
}

/** Start the loop; returns the stop. */
export function startHeartbeats(device: StoredDevice): () => void {
  const tick = () =>
    heartbeat(device).catch((error: unknown) => {
      // 403 on a signed request: the device was revoked in Admin → Printers & devices (M1-34).
      if (error instanceof ApiCallError && error.status === 403) void deviceRevoked();
    });
  void tick();
  const timer = setInterval(tick, HEARTBEAT_MS);
  const stopPrinting = startPrintHost(device);
  return () => {
    clearInterval(timer);
    stopPrinting();
  };
}
