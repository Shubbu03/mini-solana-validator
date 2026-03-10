import { PublicKey } from "@solana/web3.js";
import {
  ATA_PROGRAM_ID,
  ATA_PROGRAM_PUBKEY,
  MINT_ACCOUNT_SIZE,
  SYSTEM_PROGRAM_ID,
  SYSTEM_PROGRAM_PUBKEY,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_PUBKEY,
} from "./constants";
import { Ledger } from "./ledger";
import { readMintData, readTokenAccountData, writeMintData, writeTokenAccountData } from "./token-layouts";
import type { LedgerAccount, NormalizedInstruction, NormalizedInstructionAccount } from "./types";
import { RPC_ERROR_CODES, RpcError, assertCondition } from "./errors";
import { parseU32LE, parseU64LE, safeAddU64, safeSubU64 } from "./utils";

function requireAccountMeta(accounts: NormalizedInstructionAccount[], index: number, programName: string): NormalizedInstructionAccount {
  const meta = accounts[index];
  if (!meta) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, `${programName}: missing account at index ${index}`);
  }
  return meta;
}

function requireSigner(meta: NormalizedInstructionAccount, message: string): void {
  if (!meta.isSigner) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, message);
  }
}

function getExistingAccount(accounts: Map<string, LedgerAccount>, pubkey: string, message: string): LedgerAccount {
  const account = accounts.get(pubkey);
  if (!account) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, message);
  }
  return account;
}

function assertOwnedBy(account: LedgerAccount, owner: string, message: string): void {
  if (account.owner !== owner) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, message);
  }
}

function assertTokenAccount(account: LedgerAccount): void {
  assertOwnedBy(account, TOKEN_PROGRAM_ID, "token account is not owned by token program");
  if (account.data.length !== TOKEN_ACCOUNT_SIZE) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid token account size");
  }
}

function assertMintAccount(account: LedgerAccount): void {
  assertOwnedBy(account, TOKEN_PROGRAM_ID, "mint account is not owned by token program");
  if (account.data.length !== MINT_ACCOUNT_SIZE) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid mint account size");
  }
}

function handleSystemProgram(ix: NormalizedInstruction, accounts: Map<string, LedgerAccount>): void {
  if (ix.data.length < 4) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "system instruction data too short");
  }

  const discriminator = parseU32LE(ix.data, 0);

  if (discriminator === 0) {
    const payerMeta = requireAccountMeta(ix.accounts, 0, "system");
    const newAccountMeta = requireAccountMeta(ix.accounts, 1, "system");
    requireSigner(payerMeta, "create account payer must be signer");
    requireSigner(newAccountMeta, "new account must be signer");

    if (ix.data.length < 52) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid create account data");
    }

    const lamports = parseU64LE(ix.data, 4);
    const space = parseU64LE(ix.data, 12);
    if (space > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "account space too large");
    }

    const owner = new PublicKey(ix.data.subarray(20, 52)).toBase58();
    const payer = getExistingAccount(accounts, payerMeta.pubkey, "payer account does not exist");

    const existing = accounts.get(newAccountMeta.pubkey);
    if (existing && (existing.lamports > 0n || existing.data.length > 0)) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "account already in use");
    }

    payer.lamports = safeSubU64(payer.lamports, lamports, "insufficient funds");

    accounts.set(newAccountMeta.pubkey, {
      pubkey: newAccountMeta.pubkey,
      lamports,
      owner,
      data: Buffer.alloc(Number(space)),
      executable: false,
      rentEpoch: 0,
    });

    return;
  }

  if (discriminator === 2) {
    const sourceMeta = requireAccountMeta(ix.accounts, 0, "system");
    const destinationMeta = requireAccountMeta(ix.accounts, 1, "system");
    requireSigner(sourceMeta, "transfer source must be signer");

    if (ix.data.length < 12) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid transfer data");
    }

    const lamports = parseU64LE(ix.data, 4);
    const source = getExistingAccount(accounts, sourceMeta.pubkey, "source account does not exist");

    const destination =
      accounts.get(destinationMeta.pubkey) ??
      {
        pubkey: destinationMeta.pubkey,
        lamports: 0n,
        owner: SYSTEM_PROGRAM_ID,
        data: Buffer.alloc(0),
        executable: false,
        rentEpoch: 0,
      };

    source.lamports = safeSubU64(source.lamports, lamports, "insufficient funds");
    destination.lamports = safeAddU64(destination.lamports, lamports, "lamports overflow");

    accounts.set(destinationMeta.pubkey, destination);
    return;
  }

  throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, `unsupported system instruction: ${discriminator}`);
}

function handleTokenProgram(ix: NormalizedInstruction, accounts: Map<string, LedgerAccount>): void {
  if (ix.data.length < 1) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token instruction data too short");
  }

  const discriminator = ix.data.readUInt8(0);

  if (discriminator === 20) {
    const mintMeta = requireAccountMeta(ix.accounts, 0, "token");
    const mintAccount = getExistingAccount(accounts, mintMeta.pubkey, "mint account does not exist");
    assertMintAccount(mintAccount);

    if (ix.data.length < 67) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid initialize mint data");
    }

    const existing = readMintData(mintAccount.data);
    if (existing.isInitialized) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "mint already initialized");
    }

    const decimals = ix.data.readUInt8(1);
    const mintAuthority = new PublicKey(ix.data.subarray(2, 34)).toBase58();
    const hasFreezeAuthority = ix.data.readUInt8(34) === 1;
    const freezeAuthority = new PublicKey(ix.data.subarray(35, 67)).toBase58();

    writeMintData(mintAccount.data, {
      mintAuthorityOption: 1,
      mintAuthority,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: hasFreezeAuthority ? 1 : 0,
      freezeAuthority: hasFreezeAuthority ? freezeAuthority : SYSTEM_PROGRAM_ID,
    });

    return;
  }

  if (discriminator === 18) {
    const tokenMeta = requireAccountMeta(ix.accounts, 0, "token");
    const mintMeta = requireAccountMeta(ix.accounts, 1, "token");

    if (ix.data.length < 33) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid initialize account data");
    }

    const owner = new PublicKey(ix.data.subarray(1, 33)).toBase58();
    const tokenAccount = getExistingAccount(accounts, tokenMeta.pubkey, "token account does not exist");
    const mintAccount = getExistingAccount(accounts, mintMeta.pubkey, "mint account does not exist");

    assertTokenAccount(tokenAccount);
    assertMintAccount(mintAccount);

    const mintData = readMintData(mintAccount.data);
    if (!mintData.isInitialized) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "mint is not initialized");
    }

    const tokenData = readTokenAccountData(tokenAccount.data);
    if (tokenData.state !== 0) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token account already initialized");
    }

    writeTokenAccountData(tokenAccount.data, {
      mint: mintMeta.pubkey,
      owner,
      amount: 0n,
      state: 1,
    });

    return;
  }

  if (discriminator === 7) {
    const mintMeta = requireAccountMeta(ix.accounts, 0, "token");
    const destinationMeta = requireAccountMeta(ix.accounts, 1, "token");
    const authorityMeta = requireAccountMeta(ix.accounts, 2, "token");
    requireSigner(authorityMeta, "mint authority must be signer");

    if (ix.data.length < 9) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid mintTo data");
    }

    const amount = parseU64LE(ix.data, 1);
    const mintAccount = getExistingAccount(accounts, mintMeta.pubkey, "mint account does not exist");
    const destinationAccount = getExistingAccount(accounts, destinationMeta.pubkey, "destination account does not exist");

    assertMintAccount(mintAccount);
    assertTokenAccount(destinationAccount);

    const mintData = readMintData(mintAccount.data);
    if (!mintData.isInitialized || mintData.mintAuthorityOption !== 1 || mintData.mintAuthority !== authorityMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid mint authority");
    }

    const destinationData = readTokenAccountData(destinationAccount.data);
    if (destinationData.state !== 1 || destinationData.mint !== mintMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid destination token account");
    }

    destinationData.amount = safeAddU64(destinationData.amount, amount, "token amount overflow");
    mintData.supply = safeAddU64(mintData.supply, amount, "mint supply overflow");

    writeTokenAccountData(destinationAccount.data, destinationData);
    writeMintData(mintAccount.data, mintData);

    return;
  }

  if (discriminator === 3) {
    const sourceMeta = requireAccountMeta(ix.accounts, 0, "token");
    const destinationMeta = requireAccountMeta(ix.accounts, 1, "token");
    const ownerMeta = requireAccountMeta(ix.accounts, 2, "token");
    requireSigner(ownerMeta, "token owner must be signer");

    if (ix.data.length < 9) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid transfer data");
    }

    const amount = parseU64LE(ix.data, 1);
    const sourceAccount = getExistingAccount(accounts, sourceMeta.pubkey, "source token account does not exist");
    const destinationAccount = getExistingAccount(accounts, destinationMeta.pubkey, "destination token account does not exist");

    assertTokenAccount(sourceAccount);
    assertTokenAccount(destinationAccount);

    const sourceData = readTokenAccountData(sourceAccount.data);
    const destinationData = readTokenAccountData(destinationAccount.data);

    if (sourceData.state !== 1 || destinationData.state !== 1) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token accounts must be initialized");
    }

    if (sourceData.owner !== ownerMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "owner does not match source token account");
    }

    if (sourceData.mint !== destinationData.mint) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token mint mismatch");
    }

    sourceData.amount = safeSubU64(sourceData.amount, amount, "insufficient token balance");
    destinationData.amount = safeAddU64(destinationData.amount, amount, "token amount overflow");

    writeTokenAccountData(sourceAccount.data, sourceData);
    writeTokenAccountData(destinationAccount.data, destinationData);

    return;
  }

  if (discriminator === 12) {
    const sourceMeta = requireAccountMeta(ix.accounts, 0, "token");
    const mintMeta = requireAccountMeta(ix.accounts, 1, "token");
    const destinationMeta = requireAccountMeta(ix.accounts, 2, "token");
    const ownerMeta = requireAccountMeta(ix.accounts, 3, "token");
    requireSigner(ownerMeta, "token owner must be signer");

    if (ix.data.length < 10) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid transferChecked data");
    }

    const amount = parseU64LE(ix.data, 1);
    const decimals = ix.data.readUInt8(9);

    const sourceAccount = getExistingAccount(accounts, sourceMeta.pubkey, "source token account does not exist");
    const mintAccount = getExistingAccount(accounts, mintMeta.pubkey, "mint account does not exist");
    const destinationAccount = getExistingAccount(accounts, destinationMeta.pubkey, "destination token account does not exist");

    assertTokenAccount(sourceAccount);
    assertMintAccount(mintAccount);
    assertTokenAccount(destinationAccount);

    const sourceData = readTokenAccountData(sourceAccount.data);
    const destinationData = readTokenAccountData(destinationAccount.data);
    const mintData = readMintData(mintAccount.data);

    if (!mintData.isInitialized || mintData.decimals !== decimals) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "mint decimals mismatch");
    }

    if (sourceData.owner !== ownerMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "owner does not match source token account");
    }

    if (sourceData.mint !== mintMeta.pubkey || destinationData.mint !== mintMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token mint mismatch");
    }

    sourceData.amount = safeSubU64(sourceData.amount, amount, "insufficient token balance");
    destinationData.amount = safeAddU64(destinationData.amount, amount, "token amount overflow");

    writeTokenAccountData(sourceAccount.data, sourceData);
    writeTokenAccountData(destinationAccount.data, destinationData);

    return;
  }

  if (discriminator === 8) {
    const tokenMeta = requireAccountMeta(ix.accounts, 0, "token");
    const mintMeta = requireAccountMeta(ix.accounts, 1, "token");
    const ownerMeta = requireAccountMeta(ix.accounts, 2, "token");
    requireSigner(ownerMeta, "token owner must be signer");

    if (ix.data.length < 9) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid burn data");
    }

    const amount = parseU64LE(ix.data, 1);
    const tokenAccount = getExistingAccount(accounts, tokenMeta.pubkey, "token account does not exist");
    const mintAccount = getExistingAccount(accounts, mintMeta.pubkey, "mint account does not exist");

    assertTokenAccount(tokenAccount);
    assertMintAccount(mintAccount);

    const tokenData = readTokenAccountData(tokenAccount.data);
    const mintData = readMintData(mintAccount.data);

    if (tokenData.owner !== ownerMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "owner does not match token account");
    }

    if (tokenData.mint !== mintMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token mint mismatch");
    }

    tokenData.amount = safeSubU64(tokenData.amount, amount, "insufficient token balance");
    mintData.supply = safeSubU64(mintData.supply, amount, "insufficient mint supply");

    writeTokenAccountData(tokenAccount.data, tokenData);
    writeMintData(mintAccount.data, mintData);

    return;
  }

  if (discriminator === 9) {
    const tokenMeta = requireAccountMeta(ix.accounts, 0, "token");
    const destinationMeta = requireAccountMeta(ix.accounts, 1, "token");
    const ownerMeta = requireAccountMeta(ix.accounts, 2, "token");
    requireSigner(ownerMeta, "token owner must be signer");

    const tokenAccount = getExistingAccount(accounts, tokenMeta.pubkey, "token account does not exist");
    assertTokenAccount(tokenAccount);

    const tokenData = readTokenAccountData(tokenAccount.data);
    if (tokenData.owner !== ownerMeta.pubkey) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "owner does not match token account");
    }

    if (tokenData.amount !== 0n) {
      throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "token account balance must be zero to close");
    }

    const destination =
      accounts.get(destinationMeta.pubkey) ??
      {
        pubkey: destinationMeta.pubkey,
        lamports: 0n,
        owner: SYSTEM_PROGRAM_ID,
        data: Buffer.alloc(0),
        executable: false,
        rentEpoch: 0,
      };

    destination.lamports = safeAddU64(destination.lamports, tokenAccount.lamports, "lamports overflow");

    accounts.set(destinationMeta.pubkey, destination);
    accounts.delete(tokenMeta.pubkey);
    return;
  }

  throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, `unsupported token instruction: ${discriminator}`);
}

function handleAtaProgram(ix: NormalizedInstruction, accounts: Map<string, LedgerAccount>, ledger: Ledger): void {
  const payerMeta = requireAccountMeta(ix.accounts, 0, "ata");
  const ataMeta = requireAccountMeta(ix.accounts, 1, "ata");
  const ownerMeta = requireAccountMeta(ix.accounts, 2, "ata");
  const mintMeta = requireAccountMeta(ix.accounts, 3, "ata");
  const systemMeta = requireAccountMeta(ix.accounts, 4, "ata");
  const tokenMeta = requireAccountMeta(ix.accounts, 5, "ata");

  requireSigner(payerMeta, "ata payer must be signer");

  if (!(ix.data.length === 0 || (ix.data.length >= 1 && ix.data.readUInt8(0) === 0))) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "unsupported associated token account instruction");
  }

  if (systemMeta.pubkey !== SYSTEM_PROGRAM_ID) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid system program for ata create");
  }

  if (tokenMeta.pubkey !== TOKEN_PROGRAM_ID) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "invalid token program for ata create");
  }

  const [derivedAta] = PublicKey.findProgramAddressSync(
    [new PublicKey(ownerMeta.pubkey).toBuffer(), TOKEN_PROGRAM_PUBKEY.toBuffer(), new PublicKey(mintMeta.pubkey).toBuffer()],
    ATA_PROGRAM_PUBKEY,
  );

  if (derivedAta.toBase58() !== ataMeta.pubkey) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "associated token account address mismatch");
  }

  const existingAta = accounts.get(ataMeta.pubkey);
  if (existingAta && (existingAta.lamports > 0n || existingAta.data.length > 0)) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "associated token account already exists");
  }

  const payer = getExistingAccount(accounts, payerMeta.pubkey, "payer account does not exist");
  const mintAccount = getExistingAccount(accounts, mintMeta.pubkey, "mint account does not exist");
  assertMintAccount(mintAccount);

  const mintData = readMintData(mintAccount.data);
  if (!mintData.isInitialized) {
    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, "mint is not initialized");
  }

  const rent = ledger.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
  payer.lamports = safeSubU64(payer.lamports, rent, "insufficient funds for ata rent");

  const ataAccount: LedgerAccount = {
    pubkey: ataMeta.pubkey,
    lamports: rent,
    owner: TOKEN_PROGRAM_ID,
    data: Buffer.alloc(TOKEN_ACCOUNT_SIZE),
    executable: false,
    rentEpoch: 0,
  };

  writeTokenAccountData(ataAccount.data, {
    mint: mintMeta.pubkey,
    owner: ownerMeta.pubkey,
    amount: 0n,
    state: 1,
  });

  accounts.set(ataMeta.pubkey, ataAccount);
}

export function executeInstructions(
  ledger: Ledger,
  instructions: NormalizedInstruction[],
  accounts: Map<string, LedgerAccount>,
): void {
  for (const ix of instructions) {
    if (ix.programId === SYSTEM_PROGRAM_ID) {
      handleSystemProgram(ix, accounts);
      continue;
    }

    if (ix.programId === TOKEN_PROGRAM_ID) {
      handleTokenProgram(ix, accounts);
      continue;
    }

    if (ix.programId === ATA_PROGRAM_ID) {
      handleAtaProgram(ix, accounts, ledger);
      continue;
    }

    throw new RpcError(RPC_ERROR_CODES.TRANSACTION_FAILED, `unsupported program: ${ix.programId}`);
  }
}

export function executeTransactionAtomically(ledger: Ledger, instructions: NormalizedInstruction[]): void {
  const snapshot = ledger.snapshotAccounts();
  executeInstructions(ledger, instructions, snapshot);
  ledger.commitAccounts(snapshot);
}

export function assertProgramConstants(): void {
  assertCondition(SYSTEM_PROGRAM_PUBKEY.toBase58() === SYSTEM_PROGRAM_ID, RPC_ERROR_CODES.INVALID_REQUEST, "invalid system constant");
}
