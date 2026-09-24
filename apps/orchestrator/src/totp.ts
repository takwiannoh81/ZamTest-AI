/**
 * Time-based one-time passwords (RFC 6238), as used by Google Authenticator,
 * Microsoft Authenticator, Authy and 1Password: 6 digits, 30-second steps,
 * HMAC-SHA1, secret shared as base32.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): the code for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Checks a 6-digit code, allowing one step of clock drift either way. Returns
 * the step it matched (store it to refuse the same code twice), or null.
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now(), lastUsedStep = -1): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretBase32);
  const step = currentStep(now);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate <= lastUsedStep) continue;
    const expected = hotp(secret, candidate);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return candidate;
  }
  return null;
}

/** A new shared secret: 160 random bits, base32 (what authenticator apps expect). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

/** The otpauth:// link the QR code carries. */
export function otpauthUrl(secret: string, account: string, issuer = "ZamTech AI"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** Ten single-use recovery codes, e.g. "k7mq-2xpr-h4ta", for when the phone is lost. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(8)).toLowerCase().slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

export const hashRecoveryCode = (code: string) => createHash("sha256").update(code.trim().toLowerCase().replace(/\s/g, "")).digest("hex");
