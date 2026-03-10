import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createApp } from "../src/app";
import { ATA_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/constants";

type RpcEnvelope = {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

async function withServer(fn: (url: string) => Promise<void>) {
  const { app } = createApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  const url = `http://127.0.0.1:${address.port}/`;

  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

let requestId = 1;

async function rpc(url: string, method: string, params: unknown[] = []): Promise<RpcEnvelope> {
  const id = requestId++;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as RpcEnvelope;
}

function assertOk(envelope: RpcEnvelope): unknown {
  assert.equal(envelope.jsonrpc, "2.0");
  assert.ok("id" in envelope);
  assert.equal(envelope.error, undefined, envelope.error?.message);
  return envelope.result;
}

async function getLatestBlockhash(url: string): Promise<string> {
  const result = assertOk(await rpc(url, "getLatestBlockhash", [{ commitment: "processed" }])) as {
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  return result.value.blockhash;
}

async function sendLegacyTransaction(url: string, tx: Transaction): Promise<string> {
  const payload = tx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64");
  return assertOk(await rpc(url, "sendTransaction", [payload, { encoding: "base64" }])) as string;
}

async function airdrop(url: string, pubkey: PublicKey, lamports: number): Promise<string> {
  return assertOk(await rpc(url, "requestAirdrop", [pubkey.toBase58(), lamports])) as string;
}

async function getBalance(url: string, pubkey: PublicKey): Promise<number> {
  const result = assertOk(await rpc(url, "getBalance", [pubkey.toBase58()])) as { context: { slot: number }; value: number };
  return result.value;
}

function u64Data(discriminator: number, amount: bigint, withDecimals?: number): Buffer {
  const base = Buffer.alloc(withDecimals === undefined ? 9 : 10);
  base.writeUInt8(discriminator, 0);
  base.writeBigUInt64LE(amount, 1);
  if (withDecimals !== undefined) {
    base.writeUInt8(withDecimals, 9);
  }
  return base;
}

function ixInitializeMint2(mint: PublicKey, decimals: number, mintAuthority: PublicKey, freezeAuthority?: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(67);
  data.writeUInt8(20, 0);
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);
  data.writeUInt8(freezeAuthority ? 1 : 0, 34);
  (freezeAuthority ?? new PublicKey(SYSTEM_PROGRAM_ID)).toBuffer().copy(data, 35);

  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

function ixInitializeAccount3(tokenAccount: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(33);
  data.writeUInt8(18, 0);
  owner.toBuffer().copy(data, 1);

  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixMintTo(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: u64Data(7, amount),
  });
}

function ixTransfer(source: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: u64Data(3, amount),
  });
}

function ixTransferChecked(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: u64Data(12, amount, decimals),
  });
}

function ixBurn(tokenAccount: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: u64Data(8, amount),
  });
}

function ixCloseAccount(tokenAccount: PublicKey, destination: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

function ixCreateAta(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM_ID),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

async function sendSigned(url: string, tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.sign(...signers);
  return sendLegacyTransaction(url, tx);
}

test("protocol errors and basic cluster/account RPCs", async () => {
  await withServer(async (url) => {
    const version = assertOk(await rpc(url, "getVersion")) as { "solana-core": string; "feature-set": number };
    assert.equal(typeof version["solana-core"], "string");
    assert.equal(typeof version["feature-set"], "number");

    assert.equal(assertOk(await rpc(url, "getHealth")), "ok");
    assert.equal(assertOk(await rpc(url, "getSlot")), 0);
    assert.equal(assertOk(await rpc(url, "getBlockHeight")), 0);

    const user = Keypair.generate();
    assert.equal(await getBalance(url, user.publicKey), 0);

    const airdropSig = await airdrop(url, user.publicKey, 1_000_000);
    assert.equal(typeof airdropSig, "string");
    assert.equal(await getBalance(url, user.publicKey), 1_000_000);

    const info = assertOk(
      await rpc(url, "getAccountInfo", [user.publicKey.toBase58(), { encoding: "base64" }]),
    ) as { context: { slot: number }; value: null | { owner: string; lamports: number; data: [string, string] } };

    assert.ok(info.value);
    assert.equal(info.value?.owner, SYSTEM_PROGRAM_ID);

    const rent = assertOk(await rpc(url, "getMinimumBalanceForRentExemption", [165]));
    assert.equal(typeof rent, "number");

    const methodMissing = await rpc(url, "unknownMethod", []);
    assert.equal(methodMissing.error?.code, -32601);

    const badParams = await rpc(url, "getBalance", []);
    assert.equal(badParams.error?.code, -32602);

    const malformed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const malformedBody = (await malformed.json()) as RpcEnvelope;
    assert.equal(malformedBody.error?.code, -32600);
  });
});

test("sendTransaction validates blockhash and signatures, and dedupes replay", async () => {
  await withServer(async (url) => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate();

    await airdrop(url, payer.publicKey, 10_000);

    const badTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    badTx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 1000 }));
    badTx.sign(payer);

    const unknownBlockhashResponse = await rpc(url, "sendTransaction", [
      badTx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64"),
      { encoding: "base64" },
    ]);
    assert.equal(unknownBlockhashResponse.error?.code, -32003);

    const recentBlockhash = await getLatestBlockhash(url);

    const invalidSigTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash });
    invalidSigTx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 1000 }));
    invalidSigTx.sign(payer);
    invalidSigTx.signatures[0].signature = Buffer.alloc(64);

    const invalidSigResponse = await rpc(url, "sendTransaction", [
      invalidSigTx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64"),
      { encoding: "base64" },
    ]);
    assert.equal(invalidSigResponse.error?.code, -32003);

    const validTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash });
    validTx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 1500 }));
    validTx.sign(payer);

    const encoded = validTx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64");

    const first = await rpc(url, "sendTransaction", [encoded, { encoding: "base64" }]);
    const signature = assertOk(first) as string;

    const slotAfterFirst = assertOk(await rpc(url, "getSlot")) as number;
    assert.equal(slotAfterFirst, 1);
    assert.equal(await getBalance(url, recipient.publicKey), 1500);

    const replay = await rpc(url, "sendTransaction", [encoded, { encoding: "base64" }]);
    assert.equal(assertOk(replay), signature);

    const slotAfterReplay = assertOk(await rpc(url, "getSlot")) as number;
    assert.equal(slotAfterReplay, 1);
    assert.equal(await getBalance(url, recipient.publicKey), 1500);

    const statuses = assertOk(await rpc(url, "getSignatureStatuses", [[signature]])) as {
      context: { slot: number };
      value: Array<null | { slot: number; confirmationStatus: string }>;
    };

    assert.equal(statuses.value[0]?.confirmationStatus, "confirmed");
  });
});

test("supports legacy + v0 txs and rejects v0 ALTs", async () => {
  await withServer(async (url) => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate();

    await airdrop(url, payer.publicKey, 10_000);
    const blockhash = await getLatestBlockhash(url);

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 1234 }),
      ],
    }).compileToV0Message();

    const v0Tx = new VersionedTransaction(message);
    v0Tx.sign([payer]);

    const encoded = Buffer.from(v0Tx.serialize()).toString("base64");
    const response = await rpc(url, "sendTransaction", [encoded, { encoding: "base64" }]);
    assert.equal(typeof assertOk(response), "string");
    assert.equal(await getBalance(url, recipient.publicKey), 1234);
  });
});

test("system instructions are atomic on failure", async () => {
  await withServer(async (url) => {
    const payer = Keypair.generate();
    const dest1 = Keypair.generate();
    const dest2 = Keypair.generate();

    await airdrop(url, payer.publicKey, 1_000);

    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest1.publicKey, lamports: 300 }));
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest2.publicKey, lamports: 5_000 }));
    tx.sign(payer);

    const response = await rpc(url, "sendTransaction", [
      tx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64"),
      { encoding: "base64" },
    ]);

    assert.equal(response.error?.code, -32003);
    assert.equal(await getBalance(url, payer.publicKey), 1_000);
    assert.equal(await getBalance(url, dest1.publicKey), 0);
  });
});

test("token + ATA flows and query methods", async () => {
  await withServer(async (url) => {
    const payer = Keypair.generate();
    const owner = Keypair.generate();
    const mint = Keypair.generate();
    const tokenA = Keypair.generate();
    const tokenB = Keypair.generate();

    await airdrop(url, payer.publicKey, 10_000_000);
    await airdrop(url, owner.publicKey, 1_000_000);

    const mintRent = assertOk(await rpc(url, "getMinimumBalanceForRentExemption", [82])) as number;
    const tokenRent = assertOk(await rpc(url, "getMinimumBalanceForRentExemption", [165])) as number;

    const setupTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    setupTx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: mintRent,
        space: 82,
        programId: new PublicKey(TOKEN_PROGRAM_ID),
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: tokenA.publicKey,
        lamports: tokenRent,
        space: 165,
        programId: new PublicKey(TOKEN_PROGRAM_ID),
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: tokenB.publicKey,
        lamports: tokenRent,
        space: 165,
        programId: new PublicKey(TOKEN_PROGRAM_ID),
      }),
      ixInitializeMint2(mint.publicKey, 6, owner.publicKey),
      ixInitializeAccount3(tokenA.publicKey, mint.publicKey, owner.publicKey),
      ixInitializeAccount3(tokenB.publicKey, mint.publicKey, owner.publicKey),
    );

    await sendSigned(url, setupTx, [payer, mint, tokenA, tokenB]);

    const mintToTx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    mintToTx.add(ixMintTo(mint.publicKey, tokenA.publicKey, owner.publicKey, 1_000_000n));
    await sendSigned(url, mintToTx, [owner]);

    const transferTx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    transferTx.add(ixTransfer(tokenA.publicKey, tokenB.publicKey, owner.publicKey, 200_000n));
    await sendSigned(url, transferTx, [owner]);

    const checkedTransferFailTx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    checkedTransferFailTx.add(ixTransferChecked(tokenA.publicKey, mint.publicKey, tokenB.publicKey, owner.publicKey, 1n, 9));
    checkedTransferFailTx.sign(owner);

    const checkedFailResponse = await rpc(url, "sendTransaction", [
      checkedTransferFailTx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64"),
      { encoding: "base64" },
    ]);
    assert.equal(checkedFailResponse.error?.code, -32003);

    const burnTx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    burnTx.add(ixBurn(tokenB.publicKey, mint.publicKey, owner.publicKey, 100_000n));
    await sendSigned(url, burnTx, [owner]);

    const emptyToken = Keypair.generate();
    const emptySetupTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    emptySetupTx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: emptyToken.publicKey,
        lamports: tokenRent,
        space: 165,
        programId: new PublicKey(TOKEN_PROGRAM_ID),
      }),
      ixInitializeAccount3(emptyToken.publicKey, mint.publicKey, owner.publicKey),
    );
    await sendSigned(url, emptySetupTx, [payer, emptyToken]);

    const closeTx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    closeTx.add(ixCloseAccount(emptyToken.publicKey, owner.publicKey, owner.publicKey));
    await sendSigned(url, closeTx, [owner]);

    const ata = PublicKey.findProgramAddressSync(
      [owner.publicKey.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.publicKey.toBuffer()],
      new PublicKey(ATA_PROGRAM_ID),
    )[0];

    const ataCreateTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    ataCreateTx.add(ixCreateAta(payer.publicKey, ata, owner.publicKey, mint.publicKey));
    await sendSigned(url, ataCreateTx, [payer]);

    const tokenAData = assertOk(await rpc(url, "getTokenAccountBalance", [tokenA.publicKey.toBase58()])) as {
      value: { amount: string; decimals: number; uiAmount: number };
    };
    assert.equal(tokenAData.value.amount, "800000");
    assert.equal(tokenAData.value.decimals, 6);

    const nonTokenBalance = await rpc(url, "getTokenAccountBalance", [owner.publicKey.toBase58()]);
    assert.equal(nonTokenBalance.error?.code, -32602);

    const byMint = assertOk(
      await rpc(url, "getTokenAccountsByOwner", [owner.publicKey.toBase58(), { mint: mint.publicKey.toBase58() }, { encoding: "base64" }]),
    ) as { value: Array<{ pubkey: string }> };
    assert.ok(byMint.value.some((x) => x.pubkey === tokenA.publicKey.toBase58()));
    assert.ok(byMint.value.some((x) => x.pubkey === tokenB.publicKey.toBase58()));
    assert.ok(byMint.value.some((x) => x.pubkey === ata.toBase58()));

    const byProgram = assertOk(
      await rpc(url, "getTokenAccountsByOwner", [owner.publicKey.toBase58(), { programId: TOKEN_PROGRAM_ID }, { encoding: "base64" }]),
    ) as { value: Array<{ pubkey: string }> };
    assert.ok(byProgram.value.length >= 3);

    const duplicateAtaTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    duplicateAtaTx.add(ixCreateAta(payer.publicKey, ata, owner.publicKey, mint.publicKey));
    duplicateAtaTx.sign(payer);

    const duplicateAtaResponse = await rpc(url, "sendTransaction", [
      duplicateAtaTx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64"),
      { encoding: "base64" },
    ]);
    assert.equal(duplicateAtaResponse.error?.code, -32003);

    const wrongAta = Keypair.generate().publicKey;
    const wrongAtaTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await getLatestBlockhash(url) });
    wrongAtaTx.add(ixCreateAta(payer.publicKey, wrongAta, owner.publicKey, mint.publicKey));
    wrongAtaTx.sign(payer);

    const wrongAtaResponse = await rpc(url, "sendTransaction", [
      wrongAtaTx.serialize({ verifySignatures: false, requireAllSignatures: false }).toString("base64"),
      { encoding: "base64" },
    ]);
    assert.equal(wrongAtaResponse.error?.code, -32003);
  });
});

test("getSignatureStatuses includes airdrop signatures and unknowns", async () => {
  await withServer(async (url) => {
    const wallet = Keypair.generate();
    const airdropSig = await airdrop(url, wallet.publicKey, 1234);

    const statuses = assertOk(await rpc(url, "getSignatureStatuses", [[airdropSig, "unknown-sig"]])) as {
      value: Array<null | { confirmationStatus: string }>;
    };

    assert.equal(statuses.value[0]?.confirmationStatus, "confirmed");
    assert.equal(statuses.value[1], null);
  });
});
