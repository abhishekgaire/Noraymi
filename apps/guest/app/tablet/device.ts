import { makeDeviceKey, signDeviceRequest } from "@west4/shared";

/**
 * A room tablet's identity (M3-12): paired once with a code from Admin →
 * Devices, its non-extractable key kept in this browser's IndexedDB, and
 * every room call signed with it. The API answers it as the tablet of the
 * one room it was paired to.
 */
export interface TabletDevice {
  readonly deviceId: string;
  readonly venueId: string;
  readonly name: string;
  readonly privateKey: CryptoKey;
}

/** Each kind of shared screen keeps its key in its own database: the tablet's, or the Up next TV's (M6-22). */
export type DeviceDb = "west4-tablet" | "west4-tv";
const STORE = "device";

function open(DB: DeviceDb): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function readTablet(dbName: DeviceDb = "west4-tablet"): Promise<TabletDevice | null> {
  try {
    const db = await open(dbName);
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get("device");
      r.onsuccess = () => resolve((r.result as TabletDevice | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

async function store(device: TabletDevice | null, dbName: DeviceDb): Promise<void> {
  const db = await open(dbName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (device) tx.objectStore(STORE).put(device, "device");
    else tx.objectStore(STORE).delete("device");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Claims a pairing code; only a code Admin made for this kind (a room tablet, or the Up next TV) pairs here. */
export async function pairTablet(
  code: string,
  kind: "room_tablet" | "up_next_display" = "room_tablet",
  dbName: DeviceDb = "west4-tablet",
): Promise<TabletDevice | "wrong_kind" | "refused"> {
  const key = await makeDeviceKey();
  const r = await fetch("/v1/devices/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim(), public_key: key.publicJwk }),
  }).catch(() => null);
  if (!r?.ok) return "refused";
  const claimed = (await r.json()) as {
    device_id: string;
    venue_id: string;
    kind: string;
    name: string;
  };
  if (claimed.kind !== kind) return "wrong_kind";
  const device = {
    deviceId: claimed.device_id,
    venueId: claimed.venue_id,
    name: claimed.name,
    privateKey: key.privateKey,
  };
  await store(device, dbName);
  return device;
}

export async function forgetTablet(dbName: DeviceDb = "west4-tablet"): Promise<void> {
  await store(null, dbName);
}

/** A room call signed by the tablet's key. */
export function tabletApi(device: TabletDevice) {
  return async (path: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = await signDeviceRequest({
      deviceId: device.deviceId,
      privateKey: device.privateKey,
      method,
      path,
      body: init?.body ?? "",
    });
    return fetch(path, {
      method,
      cache: "no-store",
      headers: { ...headers, ...(init?.body ? { "content-type": "application/json" } : {}) },
      ...(init?.body ? { body: init.body } : {}),
    });
  };
}
