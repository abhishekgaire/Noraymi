import { deflateSync } from "node:zlib";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { databaseUrl } from "@west4/db";
import pg from "pg";
import { makeS3, type S3Settings } from "../s3.js";

/**
 * `pnpm --filter @west4/api seed:files` (M6-27): after `pnpm seed`, puts the images behind the seed's
 * file rows in the object store (RustFS locally, S3 in staging), so the paper slips' "Photo saved" opens a
 * photo. The brief has no photos, so each is a stand-in: a blank slip with ruled lines and a signature
 * stroke, no names or numbers on it (the screen shows those beside it). It writes only rows the seed made
 * (their slugs are in `seed_ids`) and runs outside any transaction.
 */
export async function seedFiles(
  owner: pg.Pool,
  s3: S3Settings,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<number> {
  const rows = await owner.query<{ id: string; storage_key: string; kind: string }>(
    `select f.id, f.storage_key, f.kind
       from files f join seed_ids s on s.row_id = f.id and s.entity = 'files'
      where f.kind = 'slip_photo'
      order by s.slug`,
  );
  for (const [i, f] of rows.rows.entries()) {
    const png = slipPicture(i);
    await s3.client.send(
      new PutObjectCommand({
        Bucket: s3.bucketFiles,
        Key: f.storage_key,
        Body: png,
        ContentType: "image/png",
      }),
    );
    await owner.query("update files set content_type = 'image/png', bytes = $2 where id = $1", [
      f.id,
      png.byteLength,
    ]);
  }
  log(`files: ${rows.rows.length} slip photos in ${s3.bucketFiles}`);
  return rows.rows.length;
}

const WIDTH = 240;
const HEIGHT = 360;

/** A grey photo of a white slip: ruled lines and a signature stroke, a little different for each slip. */
export function slipPicture(variant: number): Buffer {
  const px = new Uint8Array(WIDTH * HEIGHT).fill(96);
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT) px[y * WIDTH + x] = v;
  };
  for (let y = 24; y < HEIGHT - 24; y++) for (let x = 30; x < WIDTH - 30; x++) set(x, y, 246);
  for (const y of [70, 100, 130, 160, 220, 300])
    for (let x = 46; x < WIDTH - 46; x++) set(x, y, 170);
  for (let t = 0; t < 400; t++) {
    const x = 56 + (t * 128) / 400;
    const y = 285 - 12 * Math.sin((t / 400) * Math.PI * (3 + variant)) - (t % 97) / 12;
    for (let d = 0; d < 2; d++) set(Math.round(x), Math.round(y) + d, 40);
  }
  return encodePng(px);
}

function encodePng(gray: Uint8Array): Buffer {
  const raw = Buffer.alloc((WIDTH + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++)
    Buffer.from(gray.subarray(y * WIDTH, (y + 1) * WIDTH)).copy(raw, y * (WIDTH + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function main(): Promise<void> {
  // The table owner (DATABASE_URL, or the DB_* parts ECS injects): seed rows are read across the venue wall.
  const owner = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await seedFiles(owner, makeS3());
  } finally {
    await owner.end();
  }
}

if (process.argv[1]?.endsWith("seed-files.ts") || process.argv[1]?.endsWith("seed-files.js"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
