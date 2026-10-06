import { createHash } from "node:crypto";
import type pg from "pg";
import type { FastifyRequest } from "fastify";
import { resolveDevice } from "@west4/db";
import {
  DEVICE_HEADERS,
  DEVICE_SIGNATURE_WINDOW_MS,
  deviceSigningString,
  verifyDeviceSignature,
} from "@west4/shared";
import type { Authenticator } from "./conventions.js";
import { ApiError } from "./errors.js";
import type { Principal } from "./principal.js";

/**
 * The device authenticator (M1-15): a request carrying the device headers is
 * checked against the device's public key, a ±5-minute timestamp and a nonce
 * seen once. A bad, missing-in-part or replayed signature is 403, never
 * silently anonymous. Signatures are checked against the real clock, not the
 * simulated one: they're security, not business time.
 */
export function deviceAuthenticator(pool: pg.Pool, now: () => number = Date.now): Authenticator {
  return async (request: FastifyRequest): Promise<Principal | undefined> => {
    // A browser can't put headers on a WebSocket, so a socket upgrade may carry the same four values as
    // query parameters (M6-22: the Up next TV follows its channel). They're signed over the URL without
    // them; the nonce is still spent once, so a logged URL can't be replayed.
    const raw = request.raw.url ?? request.url;
    const socket =
      request.method === "GET" &&
      String(request.headers.upgrade ?? "").toLowerCase() === "websocket" &&
      request.headers[DEVICE_HEADERS.id] === undefined;
    const query = socket ? splitDeviceQuery(raw) : undefined;
    const h = (name: string): string | undefined => {
      if (query?.signed) return query.values.get(name) ?? undefined;
      const v = request.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const deviceId = h(DEVICE_HEADERS.id);
    if (deviceId === undefined) return undefined;
    const timestamp = Number(h(DEVICE_HEADERS.timestamp));
    const nonce = h(DEVICE_HEADERS.nonce);
    const signature = h(DEVICE_HEADERS.signature);
    if (!Number.isFinite(timestamp) || !nonce || !signature || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
      throw new ApiError("forbidden", "the device signature is incomplete");
    }
    if (Math.abs(now() - timestamp) > DEVICE_SIGNATURE_WINDOW_MS)
      throw new ApiError("forbidden", "the device's clock is too far off");
    const device = await resolveDevice(pool, deviceId, nonce, DEVICE_SIGNATURE_WINDOW_MS);
    if (!device || device.publicJwk === null) throw new ApiError("forbidden", "unknown device");
    if (device.revoked || device.disabled)
      throw new ApiError("forbidden", "this device was revoked");
    if (!device.freshNonce) throw new ApiError("forbidden", "replayed request");
    const rawBody =
      typeof request.body === "string"
        ? request.body
        : request.body === undefined || request.body === null
          ? ""
          : JSON.stringify(request.body);
    const path = query?.signed ? query.path : raw;
    const signingString = deviceSigningString({
      method: request.method,
      path,
      bodySha256Hex: createHash("sha256").update(rawBody).digest("hex"),
      timestampMs: timestamp,
      nonce,
    });
    if (
      !(await verifyDeviceSignature({
        publicJwk: device.publicJwk,
        signatureBase64: signature,
        signingString,
      }))
    ) {
      throw new ApiError("forbidden", "bad device signature");
    }
    request.signedDevice = { deviceId, venueId: device.venueId, kind: device.kind };
    if (
      device.kind === "staff_phone" ||
      device.kind === "reader" ||
      device.kind === "nfc_reader" ||
      device.kind === "router" ||
      device.kind === "mic_outlet"
    ) {
      // These kinds don't act as a principal of their own (a staff phone signs in as its person).
      return undefined;
    }
    return { kind: "device", deviceId, venueId: device.venueId, deviceKind: device.kind };
  };
}

/** A socket URL's device values, and the URL as it was signed: the same URL without them. */
export function splitDeviceQuery(url: string): {
  signed: boolean;
  values: URLSearchParams;
  path: string;
} {
  const at = url.indexOf("?");
  if (at < 0) return { signed: false, values: new URLSearchParams(), path: url };
  const params = new URLSearchParams(url.slice(at + 1));
  const values = new URLSearchParams();
  const names: readonly string[] = Object.values(DEVICE_HEADERS);
  const rest: string[] = [];
  for (const part of url.slice(at + 1).split("&")) {
    const name = decodeURIComponent(part.split("=")[0] ?? "");
    if (!names.includes(name) && part !== "") rest.push(part);
  }
  for (const name of names) {
    const v = params.get(name);
    if (v !== null) values.set(name, v);
  }
  return {
    signed: values.has(DEVICE_HEADERS.id),
    values,
    path: url.slice(0, at) + (rest.length > 0 ? `?${rest.join("&")}` : ""),
  };
}
