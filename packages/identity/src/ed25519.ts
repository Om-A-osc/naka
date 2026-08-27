import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { sha256hex } from "@naka/shared";

export interface KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generates a fresh Ed25519 key pair (used by `naka agent register` and `naka mandate issue`). */
export function generateEd25519KeyPair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey as string, privateKeyPem: privateKey as string };
}

/** Signs `message` (already the exact bytes to be signed) with a PEM private key, returns base64. */
export function signMessage(message: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return nodeSign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

export function verifyMessage(message: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return nodeVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** The exact message format signed by both agent requests and buyer mandates. */
export function signingMessage(parts: { subject: string; ts: number; bodyHash: string; nonce?: string }): string {
  return `${parts.subject}|${parts.ts}|${parts.nonce ?? ""}|${parts.bodyHash}`;
}

export function hashBody(canonicalBodyJson: string): string {
  return sha256hex(canonicalBodyJson);
}
