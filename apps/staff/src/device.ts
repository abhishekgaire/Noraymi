import { makeDeviceKey, signDeviceRequest } from "@west4/shared";
import {
  ApiCallError,
  NetworkError,
  api,
  sessionHeaders,
  setSessionToken,
  withOfflineRead,
} from "./api.js";
import { syncServerTime } from "./clock.js";

/**
 * What this browser is (M1-15, M1-26): a paired shared screen (a bar or
 * front-desk computer, by a pairing code from Admin → Devices), a person's
 * own phone (from their invite link, M1-23), or nothing yet. The device key
 * is made here, never leaves the browser (a non-extractable WebCrypto key in
 * IndexedDB) and signs the requests the API wants signed. The desktop app
 * (M1-28) keeps the same shape in the operating system's keychain.
 */
export type DeviceKind = "bar_computer" | "front_desk" | "staff_phone";

export interface StoredDevice {
  readonly deviceId: string;
  readonly venueId: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly privateKey: CryptoKey;
  /** A staff phone's owner's PIN length, so the pad waits for every digit (4 for staff, 6 for owners and managers). */
  readonly pinDigits?: 4 | 6;
  readonly venue: {
    readonly name: string;
    readonly time_zone: string;
    readonly day_cutover: string;
  } | null;
}

const DB_NAME = "west4-staff";
const STORE = "device";
const KEY = "device";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readDevice(): Promise<StoredDevice | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as StoredDevice | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/** The device was revoked in Admin: drop its key and start the app over at sign-in, where it reads "Pair this screen". */
export async function deviceRevoked(): Promise<void> {
  await forgetDevice();
  setSessionToken(null);
  window.location.replace("/sign-in");
}

export async function forgetDevice(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Nothing stored, or storage is unavailable: the next read finds no device either way.
  }
}

export async function storeDevice(device: StoredDevice): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(device, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isShared(
  device: StoredDevice | null,
): device is StoredDevice & { kind: "bar_computer" | "front_desk" } {
  return device?.kind === "bar_computer" || device?.kind === "front_desk";
}

/** Learn the server's time from its public health answer, before any signed request. */
export async function syncClock(): Promise<void> {
  try {
    const health = await api<{ server_time: string }>("GET", "/v1/health");
    syncServerTime(health.server_time);
  } catch {
    // Offline: the device's own clock will have to do.
  }
}

/** A shared screen claims its pairing code with a fresh key and becomes the device Admin named. */
export async function claimDevice(code: string): Promise<StoredDevice> {
  const key = await makeDeviceKey();
  const claimed = await api<{
    device_id: string;
    venue_id: string;
    kind: DeviceKind;
    name: string;
    venue: { name: string; time_zone: string; day_cutover: string };
  }>("POST", "/v1/devices/claim", { code, public_key: key.publicJwk });
  const device: StoredDevice = {
    deviceId: claimed.device_id,
    venueId: claimed.venue_id,
    kind: claimed.kind,
    name: claimed.name,
    privateKey: key.privateKey,
    venue: claimed.venue,
  };
  await storeDevice(device);
  return device;
}

/** A call the device signs: the API answers as the device, or as the person on it. */
export async function signedApi<T>(
  device: StoredDevice,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  // The bar's orders keep ringing and aging on a locked screen while offline (M8-03).
  return withOfflineRead(method, path, () => liveSignedApi<T>(device, method, path, body));
}

async function liveSignedApi<T>(
  device: StoredDevice,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  // The signature carries the device's real clock (the API checks it against its own real clock, ±5 minutes,
  // never the simulated one); what the screen shows comes from the venue's clock.
  const headers = await signDeviceRequest({
    deviceId: device.deviceId,
    privateKey: device.privateKey,
    method,
    path,
    body: payload,
  });
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...headers,
        ...sessionHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: payload }),
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    } | null;
    throw new ApiCallError(
      response.status,
      parsed?.error?.code ?? "unknown",
      parsed?.error?.message ?? response.statusText,
      parsed?.error?.details ?? {},
    );
  }
  return (await response.json()) as T;
}
