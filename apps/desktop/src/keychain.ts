import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Secrets on disk only ever sealed by the operating system's keychain
 * (Electron's safeStorage, spec 12 · 6): the owner or manager's bearer token
 * and the cache's key. When the keychain isn't available the store refuses
 * to write rather than fall back to a plain file.
 */
export interface Sealer {
  isAvailable(): boolean;
  seal(plain: string): Buffer;
  open(sealed: Buffer): string;
}

export class SealedStore {
  constructor(
    private readonly file: string,
    private readonly sealer: Sealer,
  ) {}

  get(): string | null {
    if (!existsSync(this.file)) return null;
    if (!this.sealer.isAvailable()) return null;
    try {
      return this.sealer.open(readFileSync(this.file));
    } catch {
      return null;
    }
  }

  set(value: string): void {
    if (!this.sealer.isAvailable())
      throw new Error("the keychain isn't available: nothing is written");
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.sealer.seal(value), { mode: 0o600 });
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }

  /** A random key, made once and kept sealed; the same one on every later call. */
  getOrMakeKey(bytes = 32): string {
    const existing = this.get();
    if (existing) return existing;
    const made = randomBytes(bytes).toString("hex");
    this.set(made);
    return made;
  }
}
