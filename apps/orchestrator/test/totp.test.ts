import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from "../src/totp.js";

// RFC 6238 appendix B: SHA-1 with the ASCII secret "12345678901234567890", 8 digits.
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    const at = (seconds: number) => hotp(RFC_SECRET, Math.floor(seconds / 30), 8);
    expect(at(59)).toBe("94287082");
    expect(at(1111111109)).toBe("07081804");
    expect(at(1111111111)).toBe("14050471");
    expect(at(1234567890)).toBe("89005924");
    expect(at(2000000000)).toBe("69279037");
    expect(at(20000000000)).toBe("65353130");
  });

  it("round-trips base32 like authenticator apps", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").equals(RFC_SECRET)).toBe(true);
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
  });

  it("accepts the current code with one step of drift, never the same step twice", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_790_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = (s: number) => hotp(RFC_SECRET, s);
    expect(verifyTotp(secret, code(step), now)).toBe(step);
    expect(verifyTotp(secret, code(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, code(step - 2), now)).toBeNull();
    expect(verifyTotp(secret, code(step), now, step)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, `${code(step).slice(0, 3)} ${code(step).slice(3)}`, now)).toBe(step);
  });

  it("builds the QR link and recovery codes", () => {
    expect(otpauthUrl("ABC", "ada@acme.example")).toBe(
      "otpauth://totp/ZamTech%20AI:ada%40acme.example?secret=ABC&issuer=ZamTech%20AI&algorithm=SHA1&digits=6&period=30",
    );
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  });
});
