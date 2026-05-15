import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { ChainService } from '../src/services/chainService';
import { CryptoService } from '../src/services/cryptoService';
import type { ActionType, ChainBlock } from '../src/types/chain';

const GENESIS_HASH = '0'.repeat(64);
const FIXED_PRIVATE_KEY = '1'.repeat(64);
const FIXED_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(hexToBytes(FIXED_PRIVATE_KEY)));
const BASE_TIMESTAMP = 1_700_000_000_000;

type IncomingBlockDecision =
  | 'accepted'
  | 'duplicate'
  | 'conflict-resync'
  | 'gap-resync'
  | 'stale-ignored'
  | 'invalid';

function signBlockIdentity(block: Pick<ChainBlock, 'index' | 'voteHash' | 'previousHash'>): string {
  return CryptoService.sign(
    JSON.stringify({
      index: block.index,
      voteHash: block.voteHash,
      previousHash: block.previousHash,
    }),
    FIXED_PRIVATE_KEY,
  );
}

function makeSignedBlock(options: {
  index: number;
  previousHash: string;
  timestamp?: number;
  votePayload?: Record<string, unknown>;
  voteHash?: string;
  actionType?: ActionType;
  actionLabel?: string;
}): ChainBlock {
  const voteHash = options.voteHash ?? CryptoService.hashVote(options.votePayload ?? {
    pollId: `poll-${options.index}`,
    choice: 'yes',
    timestamp: options.timestamp ?? BASE_TIMESTAMP + options.index,
    deviceId: 'test-device',
  });

  const block: ChainBlock = {
    index: options.index,
    timestamp: options.timestamp ?? BASE_TIMESTAMP + options.index,
    previousHash: options.previousHash,
    voteHash,
    signature: '',
    currentHash: '',
    nonce: 0,
    pubkey: FIXED_PUBLIC_KEY,
  };

  if (options.actionType) block.actionType = options.actionType;
  if (options.actionLabel) block.actionLabel = options.actionLabel;

  block.signature = signBlockIdentity(block);
  block.currentHash = CryptoService.hashBlock(block);

  return block;
}

function makeGenesisBlock(timestamp = BASE_TIMESTAMP): ChainBlock {
  return makeSignedBlock({
    index: 0,
    timestamp,
    previousHash: GENESIS_HASH,
    voteHash: GENESIS_HASH,
  });
}

function makeNextBlock(previousBlock: ChainBlock, overrides: Partial<ChainBlock> = {}): ChainBlock {
  const block = makeSignedBlock({
    index: overrides.index ?? previousBlock.index + 1,
    timestamp: overrides.timestamp ?? previousBlock.timestamp + 1,
    previousHash: overrides.previousHash ?? previousBlock.currentHash,
    voteHash: overrides.voteHash,
    actionType: overrides.actionType,
    actionLabel: overrides.actionLabel,
  });

  return { ...block, ...overrides };
}

function withRecomputedCurrentHash(block: ChainBlock): ChainBlock {
  const updated = { ...block };
  updated.currentHash = CryptoService.hashBlock(updated);
  return updated;
}

function classifyIncomingBlock(localBlocks: ChainBlock[], incoming: ChainBlock): IncomingBlockDecision {
  if (!incoming || typeof incoming !== 'object') return 'invalid';

  const existing = localBlocks.find((block) => block.index === incoming.index);
  if (existing) {
    return existing.currentHash === incoming.currentHash ? 'duplicate' : 'conflict-resync';
  }

  if (incoming.index === 0) {
    return localBlocks.length === 0 && ChainService.validateGenesisBlock(incoming, { allowLegacy: true })
      ? 'accepted'
      : 'stale-ignored';
  }

  const latest = localBlocks[localBlocks.length - 1];
  if (!latest) return 'gap-resync';

  const expectedIndex = latest.index + 1;
  if (incoming.index !== expectedIndex) {
    return incoming.index > expectedIndex ? 'gap-resync' : 'stale-ignored';
  }

  return ChainService.validateBlock(incoming, latest, { allowLegacy: true })
    ? 'accepted'
    : 'invalid';
}

describe('chain integrity smoke', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a signed genesis block', () => {
    const genesis = makeGenesisBlock();

    expect(ChainService.validateGenesisBlock(genesis)).toBe(true);
    expect(genesis.index).toBe(0);
    expect(genesis.previousHash).toBe(GENESIS_HASH);
    expect(genesis.voteHash).toBe(GENESIS_HASH);
    expect(genesis.currentHash).toHaveLength(64);
    expect(genesis.signature).toHaveLength(128);
  });

  it('accepts a valid signed append block', () => {
    const genesis = makeGenesisBlock();
    const next = makeNextBlock(genesis, { actionType: 'vote', actionLabel: 'Vote on smoke-poll' });

    expect(ChainService.validateBlock(next, genesis)).toBe(true);
    expect(classifyIncomingBlock([genesis], next)).toBe('accepted');
  });

  it('rejects a block whose currentHash was mutated after signing', () => {
    const genesis = makeGenesisBlock();
    const next = makeNextBlock(genesis);
    const tampered = { ...next, currentHash: 'a'.repeat(64) };

    expect(ChainService.validateBlock(tampered, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], tampered)).toBe('invalid');
  });

  it('rejects a block whose voteHash was mutated even when currentHash is recomputed', () => {
    const genesis = makeGenesisBlock();
    const next = makeNextBlock(genesis);
    const tampered = withRecomputedCurrentHash({
      ...next,
      voteHash: CryptoService.hashVote({ pollId: 'smoke-poll', choice: 'tampered' }),
    });

    expect(ChainService.validateBlock(tampered, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], tampered)).toBe('invalid');
  });

  it('rejects a block with a broken previousHash link', () => {
    const genesis = makeGenesisBlock();
    const brokenPreviousHash = 'f'.repeat(64);
    const candidate = makeSignedBlock({
      index: 1,
      timestamp: genesis.timestamp + 1,
      previousHash: brokenPreviousHash,
    });

    expect(candidate.previousHash).not.toBe(genesis.currentHash);
    expect(ChainService.validateBlock(candidate, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], candidate)).toBe('invalid');
  });

  it('rejects a reordered block with a non-sequential index', () => {
    const genesis = makeGenesisBlock();
    const indexTwo = makeSignedBlock({
      index: 2,
      timestamp: genesis.timestamp + 2,
      previousHash: genesis.currentHash,
    });

    expect(ChainService.validateBlock(indexTwo, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], indexTwo)).toBe('gap-resync');
  });

  it('detects a sync gap when a future block arrives after the local head', () => {
    const genesis = makeGenesisBlock();
    const blockOne = makeNextBlock(genesis);
    const blockTwo = makeNextBlock(blockOne);

    expect(classifyIncomingBlock([genesis], blockTwo)).toBe('gap-resync');
  });

  it('treats the same index with a different hash as a fork/conflict', () => {
    const genesis = makeGenesisBlock();
    const localBlock = makeNextBlock(genesis, { actionLabel: 'local branch' });
    const conflictingBlock = makeNextBlock(genesis, { actionLabel: 'conflicting branch' });

    expect(localBlock.index).toBe(conflictingBlock.index);
    expect(localBlock.currentHash).not.toBe(conflictingBlock.currentHash);
    expect(ChainService.validateBlock(localBlock, genesis)).toBe(true);
    expect(ChainService.validateBlock(conflictingBlock, genesis)).toBe(true);
    expect(classifyIncomingBlock([genesis, localBlock], conflictingBlock)).toBe('conflict-resync');
  });

  it('ignores an exact duplicate block instead of appending it again', () => {
    const genesis = makeGenesisBlock();
    const localBlock = makeNextBlock(genesis);

    expect(classifyIncomingBlock([genesis, localBlock], { ...localBlock })).toBe('duplicate');
  });

  it('rejects a block timestamp older than the previous block', () => {
    const genesis = makeGenesisBlock(BASE_TIMESTAMP + 10);
    const older = makeSignedBlock({
      index: 1,
      timestamp: genesis.timestamp - 1,
      previousHash: genesis.currentHash,
    });

    expect(ChainService.validateBlock(older, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], older)).toBe('invalid');
  });

  it('rejects a block timestamp too far in the future', () => {
    const genesis = makeGenesisBlock();
    const future = makeSignedBlock({
      index: 1,
      timestamp: Date.now() + 31_000,
      previousHash: genesis.currentHash,
    });

    expect(ChainService.validateBlock(future, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], future)).toBe('invalid');
  });

  it('rejects a bad signature even when the block hash is recomputed', () => {
    const genesis = makeGenesisBlock();
    const next = makeNextBlock(genesis);
    const badSignature = withRecomputedCurrentHash({
      ...next,
      signature: 'b'.repeat(128),
    });

    expect(ChainService.validateBlock(badSignature, genesis)).toBe(false);
    expect(classifyIncomingBlock([genesis], badSignature)).toBe('invalid');
  });

  it('rejects malformed hash and signature formats', () => {
    const genesis = makeGenesisBlock();
    const next = makeNextBlock(genesis);

    expect(ChainService.validateBlock({ ...next, previousHash: 'not-a-hex-hash' }, genesis)).toBe(false);
    expect(ChainService.validateBlock({ ...next, voteHash: 'c'.repeat(63) }, genesis)).toBe(false);
    expect(ChainService.validateBlock({ ...next, currentHash: 'z'.repeat(64) }, genesis)).toBe(false);
    expect(
      ChainService.validateBlock(withRecomputedCurrentHash({ ...next, signature: 'd'.repeat(127) }), genesis),
    ).toBe(false);
  });

  it('rejects unsupported action types and overlong action labels', () => {
    const genesis = makeGenesisBlock();
    const next = makeNextBlock(genesis);

    const unsupportedActionType = withRecomputedCurrentHash({
      ...next,
      actionType: 'relay-admin-delete' as ActionType,
    });
    const overlongActionLabel = withRecomputedCurrentHash({
      ...next,
      actionLabel: 'x'.repeat(201),
    });

    expect(ChainService.validateBlock(unsupportedActionType, genesis)).toBe(false);
    expect(ChainService.validateBlock(overlongActionLabel, genesis)).toBe(false);
  });
});
