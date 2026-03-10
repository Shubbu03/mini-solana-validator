import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type MessageV0,
  type TransactionInstruction,
} from "@solana/web3.js";
import { RPC_ERROR_CODES, RpcError } from "./errors";
import type { DecodedTransaction, NormalizedInstruction } from "./types";
import { isAllZero } from "./utils";

function normalizeLegacyInstruction(ix: TransactionInstruction): NormalizedInstruction {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(ix.data),
  };
}

function verifyLegacySignatures(tx: Transaction): void {
  const message = tx.serializeMessage();
  for (const { publicKey, signature } of tx.signatures) {
    if (!signature || signature.length !== 64) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signature");
    }
    if (isAllZero(signature)) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signature");
    }

    const ok = nacl.sign.detached.verify(message, signature, publicKey.toBytes());
    if (!ok) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "signature verification failed");
    }
  }
}

function isWritableIndex(
  index: number,
  totalKeys: number,
  numRequiredSignatures: number,
  numReadonlySignedAccounts: number,
  numReadonlyUnsignedAccounts: number,
): boolean {
  if (index < numRequiredSignatures) {
    return index < numRequiredSignatures - numReadonlySignedAccounts;
  }

  return index < totalKeys - numReadonlyUnsignedAccounts;
}

function verifyVersionedSignatures(tx: VersionedTransaction): void {
  const message = tx.message;
  const required = message.header.numRequiredSignatures;

  if (tx.signatures.length < required) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signature");
  }

  const staticKeys = message.staticAccountKeys;
  if (staticKeys.length < required) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signer keys");
  }

  const messageBytes = message.serialize();

  for (let i = 0; i < required; i += 1) {
    const signature = tx.signatures[i];
    if (!signature || signature.length !== 64 || isAllZero(signature)) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signature");
    }

    const signerKey = staticKeys[i] as PublicKey;
    const ok = nacl.sign.detached.verify(messageBytes, signature, signerKey.toBytes());
    if (!ok) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "signature verification failed");
    }
  }
}

function normalizeVersionedInstructions(tx: VersionedTransaction): NormalizedInstruction[] {
  if (tx.version !== 0) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "unsupported transaction version");
  }

  const message = tx.message as MessageV0;
  if (message.addressTableLookups.length > 0) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "address lookup tables are not supported");
  }

  const keys = message.staticAccountKeys;
  const totalKeys = keys.length;
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = message.header;

  return message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex].toBase58(),
    accounts: ix.accountKeyIndexes.map((index) => ({
      pubkey: keys[index].toBase58(),
      isSigner: index < numRequiredSignatures,
      isWritable: isWritableIndex(
        index,
        totalKeys,
        numRequiredSignatures,
        numReadonlySignedAccounts,
        numReadonlyUnsignedAccounts,
      ),
    })),
    data: Buffer.from(ix.data),
  }));
}

function decodeLegacy(bytes: Buffer): DecodedTransaction {
  const tx = Transaction.from(bytes);
  verifyLegacySignatures(tx);

  const firstSignature = tx.signatures[0]?.signature;
  if (!firstSignature || isAllZero(firstSignature)) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signature");
  }

  const { recentBlockhash } = tx;
  if (!recentBlockhash) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing recent blockhash");
  }

  return {
    firstSignature: bs58.encode(firstSignature),
    recentBlockhash,
    instructions: tx.instructions.map(normalizeLegacyInstruction),
  };
}

function decodeVersioned(bytes: Buffer): DecodedTransaction {
  const tx = VersionedTransaction.deserialize(bytes);
  verifyVersionedSignatures(tx);

  const firstSignature = tx.signatures[0];
  if (!firstSignature || firstSignature.length !== 64 || isAllZero(firstSignature)) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "missing signature");
  }

  return {
    firstSignature: bs58.encode(firstSignature),
    recentBlockhash: tx.message.recentBlockhash,
    instructions: normalizeVersionedInstructions(tx),
  };
}

export function decodeAndVerifyTransaction(bytes: Buffer): DecodedTransaction {
  try {
    return decodeLegacy(bytes);
  } catch (error) {
    if (error instanceof RpcError) {
      // Legacy parsing succeeded far enough to raise a semantic tx error.
      throw error;
    }

    try {
      return decodeVersioned(bytes);
    } catch (secondError) {
      if (secondError instanceof RpcError) {
        throw secondError;
      }
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "failed to deserialize transaction");
    }
  }
}
