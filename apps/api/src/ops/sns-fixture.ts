import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringToSign, type SnsMessage } from "./sns.js";

/**
 * Tests only: a self-signed certificate standing in for Amazon's SNS signing certificate, and a
 * signer that signs messages the way SNS does (SignatureVersion 2, RSA-SHA256).
 */
export const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

export function makeSnsSigner() {
  const dir = mkdtempSync(join(tmpdir(), "west4-sns-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=sns.test",
      ].concat(["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]),
      { stdio: "ignore" },
    );
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const sign = (
      m: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">,
    ): SnsMessage => {
      const unsigned = { ...m, SignatureVersion: "2", SigningCertURL: CERT_URL, Signature: "" };
      const Signature = createSign("RSA-SHA256").update(stringToSign(unsigned)).sign(key, "base64");
      return { ...unsigned, Signature };
    };
    return { cert, sign, getCert: async (url: string) => (url === CERT_URL ? cert : "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
