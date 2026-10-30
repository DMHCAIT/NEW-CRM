import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export function encryptionKey(secret: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("AUTH_ENCRYPTION_KEY must be 64 hexadecimal characters (32 random bytes).");
  return Buffer.from(secret, "hex");
}

export function loginHash(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function encryptSession(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptSession(value: string, key: Buffer): string {
  const buffer = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}
