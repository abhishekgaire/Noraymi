import { randomBytes, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  claimNightKey,
  decryptSecret,
  encryptSecret,
  nightKeyRow,
  scanKeyRow,
  type NightKeyRow,
  type Queryable,
} from "@west4/db";
import { makeS3, type S3Settings } from "../s3.js";

/**
 * The key store for ID-scan keys (M8-14; Security and data retention 6): one
 * random data key per venue and business date, kept outside the database so
 * that no database backup holds it, and destroyed after `idScan.keepDays`.
 * Never called inside a database transaction.
 */
export interface IdKeyStore {
  put(ref: string, key: Buffer): Promise<void>;
  /** The key, or null once destroyed. */
  get(ref: string): Promise<Buffer | null>;
  /** Idempotent: every copy (every version) of the key is gone afterwards. */
  destroy(ref: string): Promise<void>;
}

/**
 * The key store on the object store: its own bucket (`S3_BUCKET_ID_KEYS`),
 * never backed up and never replicated. Each key is also sealed with the
 * server's key, so the bucket alone reads nothing. Destroying deletes every
 * version of the object, so a versioned bucket keeps no copy either.
 */
export function objectStoreKeys(client: S3Client, bucket: string, sealKey: Buffer): IdKeyStore {
  return {
    async put(ref, key) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: ref,
          Body: encryptSecret(sealKey, key.toString("base64")),
          ContentType: "text/plain",
        }),
      );
    },
    async get(ref) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ref }));
        const sealed = await r.Body!.transformToString();
        return Buffer.from(decryptSecret(sealKey, sealed), "base64");
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw e;
      }
    },
    async destroy(ref) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: ref }));
      const versions = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: ref }),
      );
      for (const v of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) {
        if (v.Key !== ref || !v.VersionId || v.VersionId === "null") continue;
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: ref, VersionId: v.VersionId }),
        );
      }
    },
  };
}

/** The key store on the environment's object store; the S3 client is made on first use. */
export function idKeyStore(sealKey: Buffer, s3: () => S3Settings = makeS3): IdKeyStore {
  let store: IdKeyStore | null = null;
  const real = () => {
    if (!store) {
      const settings = s3();
      store = objectStoreKeys(settings.client, settings.bucketIdKeys, sealKey);
    }
    return store;
  };
  return {
    put: (ref, key) => real().put(ref, key),
    get: (ref) => real().get(ref),
    destroy: (ref) => real().destroy(ref),
  };
}

/** For unit tests and the demo without an object store. */
export function memoryKeys(): IdKeyStore & { readonly size: number } {
  const keys = new Map<string, Buffer>();
  return {
    get size() {
      return keys.size;
    },
    async put(ref, key) {
      keys.set(ref, key);
    },
    async get(ref) {
      return keys.get(ref) ?? null;
    },
    async destroy(ref) {
      keys.delete(ref);
    },
  };
}

type InVenue = <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;

export class NightKeyDestroyedError extends Error {
  constructor() {
    super("that night's ID key has been destroyed");
  }
}

async function keyOf(row: NightKeyRow, store: IdKeyStore, sealKey: Buffer): Promise<Buffer | null> {
  if (row.destroyed_at) return null;
  if (row.key_ref) return store.get(row.key_ref);
  // A key made before M8-14, sealed by the server key in the row itself.
  return row.wrapped_key ? Buffer.from(decryptSecret(sealKey, row.wrapped_key), "base64") : null;
}

/**
 * The night's key for a scan, made on the first scan of the night. Each
 * database step is its own transaction; the key store is called between them.
 */
export async function ensureNightKey(
  inVenue: InVenue,
  store: IdKeyStore,
  sealKey: Buffer,
  venueId: string,
  businessDate: string,
): Promise<{ id: string; key: Buffer }> {
  let row = await inVenue((c) => nightKeyRow(c, venueId, businessDate));
  if (!row) {
    const ref = `id-scan/${venueId}/${businessDate}/${randomUUID()}`;
    const key = randomBytes(32);
    await store.put(ref, key);
    row = await inVenue((c) => claimNightKey(c, venueId, businessDate, ref));
    if (row.key_ref === ref) return { id: row.id, key };
    await store.destroy(ref); // a concurrent first scan claimed the night
  }
  const key = await keyOf(row, store, sealKey);
  if (!key) throw new NightKeyDestroyedError();
  return { id: row.id, key };
}

/** A scan's four fields, or null once its night's key is gone. Never part of any route or export. */
export async function openScan(
  inVenue: InVenue,
  store: IdKeyStore,
  sealKey: Buffer,
  venueId: string,
  idCheckId: string,
): Promise<Record<string, string> | null> {
  const row = await inVenue((c) => scanKeyRow(c, venueId, idCheckId));
  if (!row) return null;
  const key = await keyOf(row, store, sealKey);
  if (!key) return null;
  return JSON.parse(decryptSecret(key, row.scanned_fields)) as Record<string, string>;
}
