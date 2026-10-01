import { makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { api, ApiCallError, NetworkError } from "./api.js";

/**
 * This phone as the person's staff_phone, and its push subscription (M1-22,
 * spec 09 · Staff phones). The device key is made here, never leaves the
 * phone (a non-extractable WebCrypto key in IndexedDB), and signs the
 * subscription request so the server knows which paired phone it is.
 */
const DB_NAME = "west4-staff";
const STORE = "device";

interface StoredDevice {
  readonly venueId: string;
  readonly deviceId: string;
  readonly privateKey: CryptoKey;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readDevice(venueId: string): Promise<StoredDevice | null> {
  const db = await openDb();
  const found = await new Promise<StoredDevice | null>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(venueId);
    request.onsuccess = () => resolve((request.result as StoredDevice | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (found) return found;
  // A phone registered from an invite link, before it had signed in anywhere: adopt it for this venue.
  const pending = await new Promise<StoredDevice | null>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get("");
    request.onsuccess = () => resolve((request.result as StoredDevice | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!pending) return null;
  const adopted = { ...pending, venueId };
  await writeDevice(adopted);
  return adopted;
}

/** Keep a device this phone was given elsewhere (the invite link registers it, M1-23). */
export async function storeDevice(device: StoredDevice): Promise<void> {
  return writeDevice(device);
}

async function writeDevice(device: StoredDevice): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(device, device.venueId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The phone's device at this venue, registering it the first time. */
export async function ensureStaffPhone(venueId: string): Promise<StoredDevice> {
  const existing = await readDevice(venueId);
  if (existing) return existing;
  const key = await makeDeviceKey();
  const made = await api<{ device_id: string }>(
    "POST",
    `/v1/venues/${venueId}/devices/staff-phone`,
    {
      name: phoneName(),
      public_key: key.publicJwk,
    },
  );
  const device = { venueId, deviceId: made.device_id, privateKey: key.privateKey };
  await writeDevice(device);
  return device;
}

function phoneName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

export type PushState = "unsupported" | "needsHomeScreen" | "ready" | "denied" | "subscribed";

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Where this phone stands: a plain reading of the browser, for the setup screen. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? "needsHomeScreen" : "unsupported";
  if (isIos() && !isStandalone()) return "needsHomeScreen";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "subscribed" : "ready";
}

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // The shell works without it; alerts and install need it.
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Ask for permission, subscribe the browser, and save the subscription signed by this phone. */
export async function subscribeToPush(venueId: string): Promise<PushState> {
  if ((await pushState()) === "needsHomeScreen") return "needsHomeScreen";
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  await registerServiceWorker();
  const registration = await navigator.serviceWorker.ready;
  const { public_key } = await api<{ public_key: string }>("GET", "/v1/push/vapid-key");
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(public_key) as BufferSource,
    }));
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  const device = await ensureStaffPhone(venueId);
  const path = `/v1/venues/${venueId}/push/subscriptions`;
  const body = JSON.stringify({
    endpoint: subscription.endpoint,
    keys: { p256dh: keys["p256dh"], auth: keys["auth"] },
  });
  const headers = await signDeviceRequest({
    deviceId: device.deviceId,
    privateKey: device.privateKey,
    method: "POST",
    path,
    body,
  });
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...headers, "content-type": "application/json" },
      body,
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok)
    throw new ApiCallError(response.status, "subscribe_failed", response.statusText);
  return "subscribed";
}

export async function sendTestPush(venueId: string): Promise<void> {
  await api("POST", `/v1/venues/${venueId}/push/test`, {});
}
