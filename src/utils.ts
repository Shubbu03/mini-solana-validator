import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "node:crypto";
import { U64_MAX } from "./constants";
import { RPC_ERROR_CODES, RpcError } from "./errors";

export function parsePubkey(input: unknown, fieldName = "pubkey"): string {
  if (typeof input !== "string") {
    throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, `${fieldName} must be a base58 string`);
  }

  try {
    return new PublicKey(input).toBase58();
  } catch {
    throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, `${fieldName} must be a valid base58 pubkey`);
  }
}

export function parseU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

export function writeU64LE(buffer: Buffer, offset: number, value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "u64 overflow");
  }
  buffer.writeBigUInt64LE(value, offset);
}

export function parseU32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

export function mustBeBufferSize(data: Buffer, size: number, message: string): void {
  if (data.length !== size) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, message);
  }
}

export function generateBase58Signature(): string {
  return bs58.encode(randomBytes(64));
}

export function generateBlockhash(): string {
  return bs58.encode(randomBytes(32));
}

export function safeAddU64(a: bigint, b: bigint, errorMessage = "u64 overflow"): bigint {
  const next = a + b;
  if (next > U64_MAX) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, errorMessage);
  }
  return next;
}

export function safeSubU64(a: bigint, b: bigint, errorMessage = "insufficient funds"): bigint {
  if (a < b) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, errorMessage);
  }
  return a - b;
}

export function toBase64(data: Buffer): string {
  return data.toString("base64");
}

export function fromBase64(data: string): Buffer {
  try {
    return Buffer.from(data, "base64");
  } catch {
    throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "invalid base64 transaction payload");
  }
}

export function ensureBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, `${fieldName} must be a non-negative integer`);
  }
  return BigInt(value);
}

export function cloneBuffer(data: Buffer): Buffer {
  return Buffer.from(data);
}

export function isAllZero(bytes: Uint8Array): boolean {
  return bytes.every((x) => x === 0);
}
