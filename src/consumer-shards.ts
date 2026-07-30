/**
 * Sharding scheme for the consumer-domain datasets.
 *
 * The free/disposable lists together hold ~12.6k domains. Inlining them into
 * the bundle cost 203 kB of a 224 kB main.js — every visitor downloaded all
 * 12,642 domains so we could test the one they typed. Instead the build emits
 * one small JSON file per shard and the runtime fetches only the shard the
 * queried domain falls into (~50 domains, under 1 kB).
 *
 * This module is imported by BOTH scripts/build.ts and src/identify.ts on
 * purpose: the hash has to agree exactly on both sides, so there is only ever
 * one copy of it.
 */

/** Number of shards. 256 keeps each shard well under 1 kB at current list sizes. */
export const SHARD_COUNT = 256;

/** Public path the build writes shards to and the runtime fetches them from. */
export const SHARD_BASE_PATH = '/data/consumer';

/** What a shard file contains: `f` = free mailbox, `d` = disposable. */
export interface ConsumerShard {
    f: string[];
    d: string[];
}

/**
 * FNV-1a (32-bit), truncated to the low byte for the shard id.
 *
 * Domains are ASCII by the time they reach here — normalizeDomain lowercases
 * and the dataset filter only admits /^[a-z0-9.-]+\.[a-z]{2,}$/ — so
 * charCodeAt is safe and matches the hash style already used in render.ts.
 */
export function shardIdFor(domain: string): string {
    let h = 2166136261;
    for (let i = 0; i < domain.length; i++) {
        h ^= domain.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % SHARD_COUNT).toString(16).padStart(2, '0');
}
