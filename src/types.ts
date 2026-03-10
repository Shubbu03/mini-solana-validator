import type { PublicKey } from "@solana/web3.js";

export type RpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown[];
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: RpcId;
  result: unknown;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: RpcId;
  error: JsonRpcErrorObject;
};

export type LedgerAccount = {
  pubkey: string;
  lamports: bigint;
  owner: string;
  data: Buffer;
  executable: boolean;
  rentEpoch: number;
};

export type SignatureStatus = {
  slot: number;
  confirmations: null;
  err: null;
  confirmationStatus: "confirmed";
};

export type NormalizedInstructionAccount = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type NormalizedInstruction = {
  programId: string;
  accounts: NormalizedInstructionAccount[];
  data: Buffer;
};

export type DecodedTransaction = {
  firstSignature: string;
  recentBlockhash: string;
  instructions: NormalizedInstruction[];
};

export type RentCalculator = (dataSize: number) => bigint;

export type TxSignerMeta = {
  pubkey: PublicKey;
  signature: Uint8Array;
};
