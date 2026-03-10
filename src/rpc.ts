import { PublicKey } from "@solana/web3.js";
import { DEFAULT_FEATURE_SET, DEFAULT_SOLANA_CORE_VERSION, TOKEN_PROGRAM_ID } from "./constants";
import { RPC_ERROR_CODES, RpcError } from "./errors";
import { Ledger } from "./ledger";
import { executeTransactionAtomically } from "./programs";
import { readMintData, readTokenAccountData } from "./token-layouts";
import { decodeAndVerifyTransaction } from "./transaction";
import { RPC_VERSION } from "./constants";
import type { JsonRpcError, JsonRpcRequest, JsonRpcSuccess, RpcId } from "./types";
import { ensureBigInt, fromBase64, parsePubkey } from "./utils";

function isJsonRpcRequest(payload: unknown): payload is JsonRpcRequest {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const maybe = payload as Record<string, unknown>;
  return maybe.jsonrpc === "2.0" && "id" in maybe && typeof maybe.method === "string";
}

function ok(id: RpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: RPC_VERSION, id, result };
}

function err(id: RpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: RPC_VERSION, id, error: { code, message } };
}

function requireParamsArray(params: unknown): unknown[] {
  if (params === undefined) {
    return [];
  }

  if (!Array.isArray(params)) {
    throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "params must be an array");
  }

  return params;
}

function parseIdList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "expected an array of signatures");
  }

  for (const sig of input) {
    if (typeof sig !== "string") {
      throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "signature must be a string");
    }
  }

  return input as string[];
}

export async function handleRpcRequest(payload: unknown, ledger: Ledger): Promise<JsonRpcSuccess | JsonRpcError> {
  if (!isJsonRpcRequest(payload)) {
    return err(null, RPC_ERROR_CODES.INVALID_REQUEST, "Invalid request");
  }

  const { id, method } = payload;

  let params: unknown[];
  try {
    params = requireParamsArray(payload.params);
  } catch (error) {
    if (error instanceof RpcError) {
      return err(id, error.code, error.message);
    }
    return err(id, RPC_ERROR_CODES.INVALID_PARAMS, "Invalid params");
  }

  try {
    switch (method) {
      case "getVersion":
        return ok(id, {
          "solana-core": DEFAULT_SOLANA_CORE_VERSION,
          "feature-set": DEFAULT_FEATURE_SET,
        });

      case "getSlot":
        return ok(id, ledger.slot);

      case "getBlockHeight":
        return ok(id, ledger.blockHeight);

      case "getHealth":
        return ok(id, "ok");

      case "getLatestBlockhash": {
        const { blockhash, lastValidBlockHeight } = ledger.issueBlockhash();
        return ok(id, {
          context: { slot: ledger.slot },
          value: { blockhash, lastValidBlockHeight },
        });
      }

      case "getBalance": {
        const pubkey = parsePubkey(params[0], "pubkey");
        const account = ledger.getAccount(pubkey);
        return ok(id, {
          context: { slot: ledger.slot },
          value: Number(account?.lamports ?? 0n),
        });
      }

      case "getAccountInfo": {
        const pubkey = parsePubkey(params[0], "pubkey");
        const config = params[1];
        if (config && (typeof config !== "object" || (config as { encoding?: string }).encoding !== "base64")) {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "encoding must be base64");
        }

        const account = ledger.getAccount(pubkey);
        return ok(id, {
          context: { slot: ledger.slot },
          value: account ? ledger.accountToRpcInfo(account) : null,
        });
      }

      case "getMinimumBalanceForRentExemption": {
        if (typeof params[0] !== "number") {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "dataSize must be a number");
        }

        const value = ledger.getMinimumBalanceForRentExemption(params[0]);
        return ok(id, Number(value));
      }

      case "getTokenAccountBalance": {
        const pubkey = parsePubkey(params[0], "pubkey");
        const account = ledger.getAccount(pubkey);
        if (!account || account.owner !== TOKEN_PROGRAM_ID || account.data.length !== 165) {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "account is not a token account");
        }

        const tokenData = readTokenAccountData(account.data);
        const mintAccount = ledger.getAccount(tokenData.mint);
        if (!mintAccount || mintAccount.owner !== TOKEN_PROGRAM_ID || mintAccount.data.length !== 82) {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "token mint not found");
        }

        const mintData = readMintData(mintAccount.data);
        const amount = tokenData.amount;
        const divisor = 10 ** mintData.decimals;

        return ok(id, {
          context: { slot: ledger.slot },
          value: {
            amount: amount.toString(),
            decimals: mintData.decimals,
            uiAmount: Number(amount) / divisor,
          },
        });
      }

      case "getTokenAccountsByOwner": {
        const owner = parsePubkey(params[0], "owner");
        const filter = params[1];
        const config = params[2];

        if (config && (typeof config !== "object" || (config as { encoding?: string }).encoding !== "base64")) {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "encoding must be base64");
        }

        if (!filter || typeof filter !== "object") {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "filter must be provided");
        }

        const hasMint = typeof (filter as { mint?: unknown }).mint === "string";
        const hasProgram = typeof (filter as { programId?: unknown }).programId === "string";

        if (hasMint === hasProgram) {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "filter must include exactly one of mint or programId");
        }

        const mintFilter = hasMint ? parsePubkey((filter as { mint: string }).mint, "mint") : null;
        const programFilter = hasProgram
          ? parsePubkey((filter as { programId: string }).programId, "programId")
          : null;

        const value = ledger
          .allAccounts()
          .filter((account) => account.owner === TOKEN_PROGRAM_ID && account.data.length === 165)
          .filter((account) => {
            const tokenData = readTokenAccountData(account.data);
            if (tokenData.owner !== owner) {
              return false;
            }

            if (mintFilter) {
              return tokenData.mint === mintFilter;
            }

            if (programFilter) {
              return account.owner === programFilter;
            }

            return false;
          })
          .map((account) => ({
            pubkey: account.pubkey,
            account: ledger.accountToRpcInfo(account),
          }));

        return ok(id, {
          context: { slot: ledger.slot },
          value,
        });
      }

      case "requestAirdrop": {
        const pubkey = parsePubkey(params[0], "pubkey");
        const lamports = ensureBigInt(params[1], "lamports");
        const signature = ledger.requestAirdrop(pubkey, lamports);
        return ok(id, signature);
      }

      case "sendTransaction": {
        if (typeof params[0] !== "string") {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "encodedTx must be a base64 string");
        }

        const options = params[1] as { encoding?: string; skipPreflight?: boolean } | undefined;
        if (options?.encoding && options.encoding !== "base64") {
          throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "only base64 encoding is supported");
        }

        const rawBytes = fromBase64(params[0]);
        if (rawBytes.length === 0) {
          throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "empty transaction payload");
        }

        const decoded = decodeAndVerifyTransaction(rawBytes);

        if (!ledger.hasIssuedBlockhash(decoded.recentBlockhash)) {
          throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "unknown recent blockhash");
        }

        if (ledger.isSignatureProcessed(decoded.firstSignature)) {
          return ok(id, decoded.firstSignature);
        }

        executeTransactionAtomically(ledger, decoded.instructions);

        ledger.incrementSlotAndBlockHeight();
        ledger.markProcessedSignature(decoded.firstSignature, ledger.slot);

        return ok(id, decoded.firstSignature);
      }

      case "getSignatureStatuses": {
        const signatures = parseIdList(params[0]);
        return ok(id, {
          context: { slot: ledger.slot },
          value: signatures.map((signature) => ledger.getSignatureStatus(signature)),
        });
      }

      default:
        return err(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, "Method not found");
    }
  } catch (error) {
    if (error instanceof RpcError) {
      return err(id, error.code, error.message);
    }

    return err(id, RPC_ERROR_CODES.INVALID_REQUEST, "Invalid request");
  }
}

export function validateJsonRpcBody(payload: unknown): JsonRpcRequest {
  if (!isJsonRpcRequest(payload)) {
    throw new RpcError(RPC_ERROR_CODES.INVALID_REQUEST, "Invalid request");
  }

  return payload;
}

export function validateBase58Pubkey(value: string): string {
  return new PublicKey(value).toBase58();
}
