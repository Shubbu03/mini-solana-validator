import { RPC_VERSION } from "./constants";
import type { JsonRpcError, RpcId } from "./types";

export const RPC_ERROR_CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  TRANSACTION_FAILED: -32003,
} as const;

export class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function toRpcError(id: RpcId, error: unknown): JsonRpcError {
  if (error instanceof RpcError) {
    return {
      jsonrpc: RPC_VERSION,
      id,
      error: { code: error.code, message: error.message },
    };
  }

  return {
    jsonrpc: RPC_VERSION,
    id,
    error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid request" },
  };
}

export function assertCondition(condition: unknown, code: number, message: string): asserts condition {
  if (!condition) {
    throw new RpcError(code, message);
  }
}
