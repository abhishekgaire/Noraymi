import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SealedStore, type Sealer } from "./keychain.js";

/** A stand-in for safeStorage: the bytes on disk never contain the plaintext. */
const xorSealer = (available = true): Sealer => ({
  isAvailable: () => available,
  seal: (plain) => Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)),
  open: (sealed) => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString(),
});

describe("secrets sealed by the keychain", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the token on disk only sealed, and gives it back", () => {
    dir = mkdtempSync(join(tmpdir(), "west4-keychain-"));
    const store = new SealedStore(join(dir, "nested", "session.token"), xorSealer());
    expect(store.get()).toBeNull();
    store.set("bearer-token-abc123");
    for (const file of readdirSync(join(dir, "nested"))) {
      expect(readFileSync(join(dir, "nested", file), "latin1")).not.toContain(
        "bearer-token-abc123",
      );
    }
    expect(store.get()).toBe("bearer-token-abc123");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("refuses to write when the keychain isn't there, rather than fall back to a plain file", () => {
    dir = mkdtempSync(join(tmpdir(), "west4-keychain-"));
    const store = new SealedStore(join(dir, "session.token"), xorSealer(false));
    expect(() => store.set("token")).toThrow(/keychain/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("makes the cache key once and keeps it", () => {
    dir = mkdtempSync(join(tmpdir(), "west4-keychain-"));
    const store = new SealedStore(join(dir, "cache.key"), xorSealer());
    const first = store.getOrMakeKey();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getOrMakeKey()).toBe(first);
  });
});
