import { SYSTEM_PROGRAM_ID, TOKEN_ACCOUNT_SIZE } from "./constants";
import { RPC_ERROR_CODES, RpcError } from "./errors";
import type { LedgerAccount, SignatureStatus } from "./types";
import { cloneBuffer, generateBase58Signature, generateBlockhash, safeAddU64 } from "./utils";

export function defaultRentCalculator(dataSize: number): bigint {
  return BigInt((dataSize + 128) * 2);
}

export class Ledger {
  private accounts = new Map<string, LedgerAccount>();
  private issuedBlockhashes = new Map<string, number>();
  private signatureStatuses = new Map<string, SignatureStatus>();
  private processedSignatures = new Set<string>();

  slot = 0;
  blockHeight = 0;

  constructor(public readonly rentCalculator: (dataSize: number) => bigint = defaultRentCalculator) {}

  snapshotAccounts(): Map<string, LedgerAccount> {
    const snapshot = new Map<string, LedgerAccount>();

    for (const [pubkey, account] of this.accounts.entries()) {
      snapshot.set(pubkey, {
        ...account,
        data: cloneBuffer(account.data),
      });
    }

    return snapshot;
  }

  commitAccounts(accounts: Map<string, LedgerAccount>): void {
    this.accounts = accounts;
  }

  hasIssuedBlockhash(blockhash: string): boolean {
    return this.issuedBlockhashes.has(blockhash);
  }

  issueBlockhash(): { blockhash: string; lastValidBlockHeight: number } {
    const blockhash = generateBlockhash();
    const lastValidBlockHeight = this.blockHeight + 150;
    this.issuedBlockhashes.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight };
  }

  incrementSlotAndBlockHeight(): void {
    this.slot += 1;
    this.blockHeight += 1;
  }

  markProcessedSignature(signature: string, slot: number): void {
    this.processedSignatures.add(signature);
    this.signatureStatuses.set(signature, {
      slot,
      confirmations: null,
      err: null,
      confirmationStatus: "confirmed",
    });
  }

  markExternalSignature(signature: string): void {
    this.signatureStatuses.set(signature, {
      slot: this.slot,
      confirmations: null,
      err: null,
      confirmationStatus: "confirmed",
    });
  }

  isSignatureProcessed(signature: string): boolean {
    return this.processedSignatures.has(signature);
  }

  getSignatureStatus(signature: string): SignatureStatus | null {
    return this.signatureStatuses.get(signature) ?? null;
  }

  requestAirdrop(pubkey: string, lamports: bigint): string {
    const account = this.getOrCreateSystemAccount(pubkey, this.accounts);
    account.lamports = safeAddU64(account.lamports, lamports, "lamports overflow");

    const signature = generateBase58Signature();
    this.markExternalSignature(signature);
    return signature;
  }

  getMinimumBalanceForRentExemption(dataSize: number): bigint {
    if (!Number.isInteger(dataSize) || dataSize < 0) {
      throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "dataSize must be a non-negative integer");
    }
    return this.rentCalculator(dataSize);
  }

  getAccount(pubkey: string, accounts: Map<string, LedgerAccount> = this.accounts): LedgerAccount | undefined {
    return accounts.get(pubkey);
  }

  setAccount(account: LedgerAccount, accounts: Map<string, LedgerAccount> = this.accounts): void {
    accounts.set(account.pubkey, account);
  }

  deleteAccount(pubkey: string, accounts: Map<string, LedgerAccount> = this.accounts): void {
    accounts.delete(pubkey);
  }

  getOrCreateSystemAccount(pubkey: string, accounts: Map<string, LedgerAccount> = this.accounts): LedgerAccount {
    const existing = accounts.get(pubkey);
    if (existing) {
      return existing;
    }

    const account: LedgerAccount = {
      pubkey,
      lamports: 0n,
      owner: SYSTEM_PROGRAM_ID,
      data: Buffer.alloc(0),
      executable: false,
      rentEpoch: 0,
    };
    accounts.set(pubkey, account);
    return account;
  }

  allAccounts(accounts: Map<string, LedgerAccount> = this.accounts): LedgerAccount[] {
    return Array.from(accounts.values());
  }

  accountToRpcInfo(account: LedgerAccount): {
    data: [string, "base64"];
    executable: boolean;
    lamports: number;
    owner: string;
    rentEpoch: number;
  } {
    return {
      data: [account.data.toString("base64"), "base64"],
      executable: account.executable,
      lamports: Number(account.lamports),
      owner: account.owner,
      rentEpoch: account.rentEpoch,
    };
  }

  assertIsTokenAccount(account: LedgerAccount): void {
    if (account.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || account.data.length !== TOKEN_ACCOUNT_SIZE) {
      throw new RpcError(RPC_ERROR_CODES.INVALID_PARAMS, "account is not a token account");
    }
  }
}
