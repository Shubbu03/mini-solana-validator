# Mini Solana Validator

A lightweight, in-memory Solana JSON-RPC server for local development and testing. Drop-in replacement for `solana-test-validator` when you need fast feedback without spinning up the full validator.

## What it does

- **JSON-RPC over HTTP** — Compatible with `@solana/web3.js` and standard Solana clients
- **In-memory ledger** — Accounts, slot, block height; no persistence
- **Transaction execution** — Decodes and verifies signatures (legacy + versioned), executes atomically
- **Supported programs**: System Program, Token Program, Associated Token Account Program

## Supported RPC methods

`getVersion` · `getSlot` · `getBlockHeight` · `getHealth` · `getLatestBlockhash` · `getBalance` · `getAccountInfo` · `getMinimumBalanceForRentExemption` · `getTokenAccountBalance` · `getTokenAccountsByOwner` · `requestAirdrop` · `sendTransaction` · `getSignatureStatuses`

## Quick start

```bash
npm install
npm start
```

Server runs at `http://localhost:3000`. Point your Solana client at it:

```ts
const connection = new Connection("http://localhost:3000");
```

## Limitations

- No address lookup tables (versioned tx v0 only)
- No custom programs; only System, Token, and ATA
- No persistence; state resets on restart
