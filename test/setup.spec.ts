import { describe, it, expect } from "vitest";
import { hmacSign, hmacVerify } from "../src/setup";

const SECRET = "test-secret-do-not-use-in-production";

describe("hmacSign / hmacVerify", () => {
  it("produces a signature that verifies successfully against the same data and secret", async () => {
    const sig = await hmacSign("hello world", SECRET);
    const valid = await hmacVerify("hello world", sig, SECRET);

    expect(valid).toBe(true);
  });

  it("rejects a signature if the data was tampered with", async () => {
    const sig = await hmacSign("hello world", SECRET);
    const valid = await hmacVerify("goodbye world", sig, SECRET);

    expect(valid).toBe(false);
  });

  it("rejects a signature if the secret is wrong", async () => {
    const sig = await hmacSign("hello world", SECRET);
    const valid = await hmacVerify("hello world", sig, "a-different-secret");

    expect(valid).toBe(false);
  });

  it("rejects a signature of the wrong length instead of throwing", async () => {
    const valid = await hmacVerify("hello world", "abc", SECRET);

    expect(valid).toBe(false);
  });

  it("produces a deterministic signature for the same input", async () => {
    const sig1 = await hmacSign("same input", SECRET);
    const sig2 = await hmacSign("same input", SECRET);

    // HMAC is deterministic — same data + secret always produces the same signature.
    // (Unlike the encrypted API keys in crypto.ts, which use a random IV every time.)
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different secrets", async () => {
    const sig1 = await hmacSign("same input", "secret-one");
    const sig2 = await hmacSign("same input", "secret-two");

    expect(sig1).not.toBe(sig2);
  });
});