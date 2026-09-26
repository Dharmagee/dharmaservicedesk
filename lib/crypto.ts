import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "crypto";
import fs from "fs";
import path from "path";
import type { EncryptedBlob } from "./types";

const dataDir = path.join(process.cwd(), "data");
const keyPath = path.join(dataDir, "phi.key");

let cachedKey: Buffer | null = null;
let keySource: "environment" | "file" = "file";

function decodeKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const buf = Buffer.from(trimmed, "base64");
  return buf.length === 32 ? buf : null;
}

export function phiKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.PHI_MASTER_KEY?.trim();
  if (fromEnv) {
    const decoded = decodeKey(fromEnv);
    if (!decoded) {
      throw new Error("PHI_MASTER_KEY must be 32 bytes, as 64 hex characters or standard base64.");
    }
    keySource = "environment";
    cachedKey = decoded;
    return cachedKey;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(keyPath)) {
    const decoded = decodeKey(fs.readFileSync(keyPath, "utf8"));
    if (!decoded) throw new Error("data/phi.key is not a valid 32-byte key.");
    keySource = "file";
    cachedKey = decoded;
    return cachedKey;
  }
  const created = randomBytes(32);
  fs.writeFileSync(keyPath, created.toString("base64"), { encoding: "utf8", mode: 0o600 });
  keySource = "file";
  cachedKey = created;
  return cachedKey;
}

export function phiKeyStatus() {
  const key = phiKey();
  return {
    source: keySource,
    fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 16),
    algorithm: "AES-256-GCM",
  };
}

export function encryptString(plain: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", phiKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptString(blob: EncryptedBlob): string {
  const decipher = createDecipheriv("aes-256-gcm", phiKey(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64");
  const hash = scryptSync(password, salt, 32).toString("base64");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "base64");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

const DUMMY_HASH = hashPassword("not-a-real-password");

export function dummyPasswordHash(): string {
  return DUMMY_HASH;
}
