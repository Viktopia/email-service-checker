import { type ConsumerShard, SHARD_BASE_PATH, shardIdFor } from './consumer-shards.ts';
import { PROVIDERS } from './providers.ts';
import type { ConsumerHit, Finding, MxRecord, Provider } from './types.ts';

export function normalizeDomain(raw: string): string {
    if (!raw) return '';
    let s = raw.trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (s.includes('@')) s = s.split('@').pop() ?? '';
    return s.replace(/\.$/, '');
}

export function isValidDomain(domain: string): boolean {
    if (domain.length > 253) return false;
    // Two or more labels; each starts and ends alphanumeric with hyphens only
    // in the middle; the TLD is letters only. The previous pattern only
    // guarded the very first character, so it accepted "foo.-bar.com".
    // Punycode is plain ASCII, so IDNs still pass as xn--*.
    return /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
}

function matchProvider(mxHost: string): Provider | null {
    const host = mxHost.toLowerCase().replace(/\.$/, '');
    let best: Provider | null = null;
    let bestLen = 0;
    for (const provider of PROVIDERS) {
        for (const m of provider.matchers) {
            if ((host === m || host.endsWith(`.${m}`)) && m.length > bestLen) {
                best = provider;
                bestLen = m.length;
            }
        }
    }
    return best;
}

export function identifyProviders(mxRecords: readonly MxRecord[]): Finding[] {
    const seen = new Map<string, Finding>();
    for (const mx of mxRecords) {
        const provider = matchProvider(mx.host);
        if (!provider) continue;
        const existing = seen.get(provider.name);
        if (existing) existing.matchedMx.push(mx);
        else seen.set(provider.name, { provider, matchedMx: [mx] });
    }
    // Order findings by category importance for display:
    // gateway > forwarder > parking > relay > mailbox > consumer
    const order: Record<string, number> = {
        gateway: 0,
        forwarder: 1,
        parking: 2,
        relay: 3,
        mailbox: 4,
        consumer: 5,
    };
    return [...seen.values()].sort((a, b) => order[a.provider.category]! - order[b.provider.category]!);
}

/**
 * One in-flight promise per shard id, so checking several domains in a session
 * refetches nothing and two concurrent checks share a single request.
 */
const shardCache = new Map<string, Promise<ConsumerShard | null>>();

function loadShard(shardId: string): Promise<ConsumerShard | null> {
    const cached = shardCache.get(shardId);
    if (cached) return cached;

    const pending = fetch(`${SHARD_BASE_PATH}/${shardId}.json`)
        .then((res) => (res.ok ? (res.json() as Promise<ConsumerShard>) : null))
        .catch(() => null);

    shardCache.set(shardId, pending);
    return pending;
}

/**
 * Is this domain a known free, disposable or alias mailbox host?
 *
 * Resolves to null when the shard cannot be loaded. That is deliberate: the
 * consumer callout only supplements the MX findings, so a failed shard fetch
 * should quietly omit it rather than fail the whole lookup.
 */
export async function consumerLookup(domain: string): Promise<ConsumerHit | null> {
    const shard = await loadShard(shardIdFor(domain));
    if (!shard) return null;
    // Ordered most-specific first. A domain should never appear in more than
    // one list, but if the datasets ever disagree, saying "disposable" or
    // "alias" is more useful than the broader "free consumer mailbox".
    if (shard.d.includes(domain)) return { kind: 'disposable', domain };
    if (shard.a.includes(domain)) return { kind: 'alias', domain };
    if (shard.f.includes(domain)) return { kind: 'free', domain };
    return null;
}
