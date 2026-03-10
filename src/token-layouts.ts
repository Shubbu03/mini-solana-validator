import { PublicKey } from "@solana/web3.js";
import { MINT_ACCOUNT_SIZE, TOKEN_ACCOUNT_SIZE } from "./constants";
import { RPC_ERROR_CODES, RpcError } from "./errors";
import { parseU32LE, parseU64LE, writeU64LE } from "./utils";

export type MintData = {
  mintAuthorityOption: number;
  mintAuthority: string;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthorityOption: number;
  freezeAuthority: string;
};

export type TokenAccountData = {
  mint: string;
  owner: string;
  amount: bigint;
  state: number;
};

export function createMintBuffer(): Buffer {
  return Buffer.alloc(MINT_ACCOUNT_SIZE);
}

export function createTokenAccountBuffer(): Buffer {
  return Buffer.alloc(TOKEN_ACCOUNT_SIZE);
}

export function readMintData(buffer: Buffer): MintData {
  if (buffer.length !== MINT_ACCOUNT_SIZE) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid mint account size");
  }

  const mintAuthorityOption = parseU32LE(buffer, 0);
  const mintAuthority = new PublicKey(buffer.subarray(4, 36)).toBase58();
  const supply = parseU64LE(buffer, 36);
  const decimals = buffer.readUInt8(44);
  const isInitialized = buffer.readUInt8(45) === 1;
  const freezeAuthorityOption = parseU32LE(buffer, 46);
  const freezeAuthority = new PublicKey(buffer.subarray(50, 82)).toBase58();

  return {
    mintAuthorityOption,
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthorityOption,
    freezeAuthority,
  };
}

export function writeMintData(buffer: Buffer, data: MintData): void {
  if (buffer.length !== MINT_ACCOUNT_SIZE) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid mint account size");
  }

  buffer.writeUInt32LE(data.mintAuthorityOption, 0);
  const mintAuthorityBytes = new PublicKey(data.mintAuthority).toBuffer();
  mintAuthorityBytes.copy(buffer, 4);

  writeU64LE(buffer, 36, data.supply);
  buffer.writeUInt8(data.decimals, 44);
  buffer.writeUInt8(data.isInitialized ? 1 : 0, 45);

  buffer.writeUInt32LE(data.freezeAuthorityOption, 46);
  const freezeAuthorityBytes = new PublicKey(data.freezeAuthority).toBuffer();
  freezeAuthorityBytes.copy(buffer, 50);
}

export function readTokenAccountData(buffer: Buffer): TokenAccountData {
  if (buffer.length !== TOKEN_ACCOUNT_SIZE) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid token account size");
  }

  const mint = new PublicKey(buffer.subarray(0, 32)).toBase58();
  const owner = new PublicKey(buffer.subarray(32, 64)).toBase58();
  const amount = parseU64LE(buffer, 64);
  const state = buffer.readUInt8(108);

  return { mint, owner, amount, state };
}

export function writeTokenAccountData(buffer: Buffer, data: TokenAccountData): void {
  if (buffer.length !== TOKEN_ACCOUNT_SIZE) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid token account size");
  }

  new PublicKey(data.mint).toBuffer().copy(buffer, 0);
  new PublicKey(data.owner).toBuffer().copy(buffer, 32);
  writeU64LE(buffer, 64, data.amount);
  buffer.writeUInt8(data.state, 108);
}
