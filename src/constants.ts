import { PublicKey } from "@solana/web3.js";

export const RPC_VERSION = "2.0" as const;

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const SYSTEM_PROGRAM_PUBKEY = new PublicKey(SYSTEM_PROGRAM_ID);
export const TOKEN_PROGRAM_PUBKEY = new PublicKey(TOKEN_PROGRAM_ID);
export const ATA_PROGRAM_PUBKEY = new PublicKey(ATA_PROGRAM_ID);

export const MINT_ACCOUNT_SIZE = 82;
export const TOKEN_ACCOUNT_SIZE = 165;
export const U64_MAX = (1n << 64n) - 1n;

export const DEFAULT_SOLANA_CORE_VERSION = "1.18.0";
export const DEFAULT_FEATURE_SET = 1;
