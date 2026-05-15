import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ChainService } from '../src/services/chainService';
import { CryptoService } from '../src/services/cryptoService';
import type { ChainBlock } from '../src/types/chain';

const GENESIS_HASH = '0'.repeat(64);
const FIXED_PRIVATE_KEY = '1'.repeat(64);
const FIXED_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(hexToBytes(FIXED_PRIVATE_KEY)));
const BASE_TIMESTAMP = 1_700_000_000_000;

type SyncMessage =
  | { type: 'new-block'; block: ChainBlock }
  | { type: 'request-sync'; lastIndex: number }
  | { type: 'sync-response'; blocks: ChainBlock[] };

type PeerDecision =
  | 'accepted'
  | 'duplicate'
  | 'conflict-resync'
  | 'gap-resync'
  | 'stale-ignored'
  | 'invalid'
  | 'ignored';

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
  voteHash?: string;
  votePayload?: Record<string, unknown>;
}): ChainBlock {
  const timestamp = options.timestamp ?? BASE_TIMESTAMP + options.index;
  const voteHash =
    options.voteHash ??
    CryptoService.hashVote({
      pollId: `sync-smoke-poll-${options.index}`,
      choice: 'yes',
      timestamp,
      deviceId: 'sync-smoke-device',
      ...(options.votePayload ?? {}),
    });

  const block: ChainBlock = {
    index: options.index,
    timestamp,
    previousHash: options.previousHash,
    voteHash,
    signature: '',
    currentHash: '',
    nonce: 0,
    pubkey: FIXED_PUBLIC_KEY,
  };

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

function makeNextBlock(previousBlock: ChainBlock, votePayload: Record<string, unknown> = {}): ChainBlock {
  return makeSignedBlock({
    index: previousBlock.index + 1,
    timestamp: previousBlock.timestamp + 1,
    previousHash: previousBlock.currentHash,
    votePayload,
  });
}

function makeChain(length: number): ChainBlock[] {
  if (length < 1) {
    throw new Error('makeChain requires at least one block.');
  }

  const blocks = [makeGenesisBlock()];
  while (blocks.length < length) {
    blocks.push(makeNextBlock(blocks[blocks.length - 1], { sequence: blocks.length }));
  }

  return blocks;
}

function recomputeCurrentHash(block: ChainBlock): ChainBlock {
  const updated = { ...block };
  updated.currentHash = CryptoService.hashBlock(updated);
  return updated;
}

class LocalSyncPeer {
  readonly peerId: string;
  readonly blocks: ChainBlock[] = [];
  resyncRequests = 0;
  rejectedMessages = 0;

  constructor(peerId: string, initialBlocks: ChainBlock[] = []) {
    this.peerId = peerId;
    this.blocks = [...initialBlocks].sort((a, b) => a.index - b.index);
  }

  get lastIndex(): number {
    return this.blocks.length > 0 ? this.blocks[this.blocks.length - 1].index : -1;
  }

  get chainHead(): { index: number; hash: string } | null {
    const latest = this.blocks[this.blocks.length - 1];
    return latest ? { index: latest.index, hash: latest.currentHash } : null;
  }

  createSyncRequest(): SyncMessage {
    return { type: 'request-sync', lastIndex: this.lastIndex };
  }

  handleMessage(message: unknown): SyncMessage | null {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.rejectedMessages++;
      return null;
    }

    const typed = message as Partial<SyncMessage>;

    if (typed.type === 'request-sync') {
      if (typeof typed.lastIndex !== 'number' || !Number.isInteger(typed.lastIndex)) {
        this.rejectedMessages++;
        return null;
      }

      const missingBlocks =
        typed.lastIndex >= 0
          ? this.blocks.filter((block) => block.index > typed.lastIndex)
          : this.blocks;

      return missingBlocks.length > 0
        ? { type: 'sync-response', blocks: missingBlocks }
        : null;
    }

    if (typed.type === 'sync-response') {
      if (!Array.isArray(typed.blocks)) {
        this.rejectedMessages++;
        return null;
      }

      this.ingestSyncResponse(typed.blocks);
      return null;
    }

    if (typed.type === 'new-block') {
      if (!('block' in typed)) {
        this.rejectedMessages++;
        return null;
      }

      this.ingestBlock((typed as { block: unknown }).block);
      return null;
    }

    this.rejectedMessages++;
    return null;
  }

  ingestSyncResponse(incomingBlocks: unknown[]): PeerDecision[] {
    const sorted = [...incomingBlocks].sort((left, right) => {
      const leftIndex = typeof (left as ChainBlock)?.index === 'number' ? (left as ChainBlock).index : Number.MAX_SAFE_INTEGER;
      const rightIndex = typeof (right as ChainBlock)?.index === 'number' ? (right as ChainBlock).index : Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });

    return sorted.map((block) => this.ingestBlock(block));
  }

  ingestBlock(incoming: unknown): PeerDecision {
    if (!incoming || typeof incoming !== 'object') {
      this.rejectedMessages++;
      return 'invalid';
    }

    const block = incoming as ChainBlock;

    if (!Number.isInteger(block.index)) {
      this.rejectedMessages++;
      return 'invalid';
    }

    const existing = this.blocks.find((localBlock) => localBlock.index === block.index);
    if (existing) {
      if (existing.currentHash !== block.currentHash) {
        this.resyncRequests++;
        return 'conflict-resync';
      }

      return 'duplicate';
    }

    if (block.index === 0) {
      if (this.blocks.length === 0 && ChainService.validateGenesisBlock(block, { allowLegacy: true })) {
        this.blocks.push(block);
        return 'accepted';
      }

      return 'stale-ignored';
    }

    const latest = this.blocks[this.blocks.length - 1];
    if (!latest) {
      this.resyncRequests++;
      return 'gap-resync';
    }

    const expectedIndex = latest.index + 1;
    if (block.index !== expectedIndex) {
      if (block.index > expectedIndex) {
        this.resyncRequests++;
        return 'gap-resync';
      }

      return 'stale-ignored';
    }

    if (!ChainService.validateBlock(block, latest, { allowLegacy: true })) {
      this.rejectedMessages++;
      return 'invalid';
    }

    this.blocks.push(block);
    this.blocks.sort((a, b) => a.index - b.index);
    return 'accepted';
  }
}

describe('local sync smoke', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs an empty peer from lastIndex -1 to the sender chain head', () => {
    const sourceChain = makeChain(3);
    const peerA = new LocalSyncPeer('peer-a', sourceChain);
    const peerB = new LocalSyncPeer('peer-b');

    const request = peerB.createSyncRequest();
    expect(request).toEqual({ type: 'request-sync', lastIndex: -1 });

    const response = peerA.handleMessage(request);
    expect(response).toEqual({ type: 'sync-response', blocks: sourceChain });

    peerB.handleMessage(response);

    expect(peerB.blocks).toHaveLength(sourceChain.length);
    expect(peerB.chainHead).toEqual(peerA.chainHead);
    expect(peerB.resyncRequests).toBe(0);
    expect(peerB.rejectedMessages).toBe(0);
  });

  it('syncs only blocks missing after the requester lastIndex', () => {
    const sourceChain = makeChain(4);
    const peerA = new LocalSyncPeer('peer-a', sourceChain);
    const peerC = new LocalSyncPeer('peer-c', [sourceChain[0]]);

    const request = peerC.createSyncRequest();
    expect(request).toEqual({ type: 'request-sync', lastIndex: 0 });

    const response = peerA.handleMessage(request);
    expect(response).toEqual({
      type: 'sync-response',
      blocks: [sourceChain[1], sourceChain[2], sourceChain[3]],
    });

    peerC.handleMessage(response);

    expect(peerC.blocks).toHaveLength(sourceChain.length);
    expect(peerC.chainHead).toEqual(peerA.chainHead);
  });

  it('sorts out-of-order sync-response blocks before ingesting them', () => {
    const sourceChain = makeChain(4);
    const peer = new LocalSyncPeer('peer-b');

    peer.handleMessage({
      type: 'sync-response',
      blocks: [sourceChain[3], sourceChain[1], sourceChain[0], sourceChain[2]],
    });

    expect(peer.blocks.map((block) => block.index)).toEqual([0, 1, 2, 3]);
    expect(peer.chainHead).toEqual({
      index: sourceChain[3].index,
      hash: sourceChain[3].currentHash,
    });
    expect(peer.resyncRequests).toBe(0);
  });

  it('does not append duplicate blocks twice', () => {
    const sourceChain = makeChain(2);
    const peer = new LocalSyncPeer('peer-b');

    peer.handleMessage({ type: 'sync-response', blocks: sourceChain });
    peer.handleMessage({ type: 'new-block', block: sourceChain[1] });
    peer.handleMessage({ type: 'sync-response', blocks: [sourceChain[0], sourceChain[1]] });

    expect(peer.blocks.map((block) => block.index)).toEqual([0, 1]);
    expect(peer.chainHead).toEqual({
      index: sourceChain[1].index,
      hash: sourceChain[1].currentHash,
    });
  });

  it('detects a future block gap and requests resync instead of appending', () => {
    const sourceChain = makeChain(3);
    const peer = new LocalSyncPeer('peer-b', [sourceChain[0]]);

    const decision = peer.ingestBlock(sourceChain[2]);

    expect(decision).toBe('gap-resync');
    expect(peer.blocks.map((block) => block.index)).toEqual([0]);
    expect(peer.resyncRequests).toBe(1);
  });

  it('treats same-index different-hash blocks as a fork/conflict', () => {
    const genesis = makeGenesisBlock();
    const localBlock = makeNextBlock(genesis, { branch: 'local' });
    const conflictingBlock = makeNextBlock(genesis, { branch: 'conflicting' });

    const peer = new LocalSyncPeer('peer-b', [genesis, localBlock]);
    const decision = peer.ingestBlock(conflictingBlock);

    expect(localBlock.index).toBe(conflictingBlock.index);
    expect(localBlock.currentHash).not.toBe(conflictingBlock.currentHash);
    expect(decision).toBe('conflict-resync');
    expect(peer.chainHead).toEqual({
      index: localBlock.index,
      hash: localBlock.currentHash,
    });
    expect(peer.resyncRequests).toBe(1);
  });

  it('rejects corrupt block material delivered through sync-response', () => {
    const sourceChain = makeChain(2);
    const corruptBlock = recomputeCurrentHash({
      ...sourceChain[1],
      voteHash: CryptoService.hashVote({ tampered: true }),
    });

    const peer = new LocalSyncPeer('peer-b', [sourceChain[0]]);
    const decisions = peer.ingestSyncResponse([corruptBlock]);

    expect(decisions).toEqual(['invalid']);
    expect(peer.blocks).toEqual([sourceChain[0]]);
    expect(peer.rejectedMessages).toBe(1);
  });

  it('ignores malformed message payloads without crashing or mutating chain state', () => {
    const sourceChain = makeChain(2);
    const peer = new LocalSyncPeer('peer-b', [sourceChain[0]]);

    expect(peer.handleMessage(null)).toBeNull();
    expect(peer.handleMessage({})).toBeNull();
    expect(peer.handleMessage({ type: 'request-sync', lastIndex: '0' })).toBeNull();
    expect(peer.handleMessage({ type: 'sync-response', blocks: 'not-an-array' })).toBeNull();
    expect(peer.handleMessage({ type: 'new-block' })).toBeNull();
    expect(peer.handleMessage({ type: 'unknown-message-family' })).toBeNull();

    expect(peer.blocks).toEqual([sourceChain[0]]);
    expect(peer.rejectedMessages).toBe(6);
  });
});