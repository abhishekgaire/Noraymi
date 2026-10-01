import { signedApi, type StoredDevice } from "./device.js";

/**
 * A paired shared screen checks in every 30 seconds (M1-16, spec 09): its app
 * version, its clock, and the USB readers it can see (registered once each as
 * devices of their own, M1-30). The server raises the alert when a screen goes
 * quiet; the screen itself does nothing with the answer.
 */
export const HEARTBEAT_MS = 30_000;

const registered = new Map<string, string>();

async function attachedIds(device: StoredDevice): Promise<string[]> {
  const shell = typeof window === "undefined" ? undefined : window.west4;
  if (!shell) return [];
  const readers = await shell.readers().catch(() => []);
  const ids: string[] = [];
  for (const reader of readers) {
    let id = registered.get(reader.serial);
    if (!id) {
      try {
        const made = await signedApi<{ device_id: string }>(
          device,
          "POST",
          `/v1/venues/${device.venueId}/devices/attached`,
          {
            kind: "nfc_reader",
            name: reader.name,
            serial: reader.serial,
          },
        );
        id = made.device_id;
        registered.set(reader.serial, id);
      } catch {
        continue;
      }
    }
    ids.push(id);
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
  const tick = () => heartbeat(device).catch(() => {});
  void tick();
  const timer = setInterval(tick, HEARTBEAT_MS);
  return () => clearInterval(timer);
}
