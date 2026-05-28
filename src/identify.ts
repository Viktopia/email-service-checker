import type { ConsumerHit, Finding, MxRecord, Provider } from './types.ts';
import { PROVIDERS } from './providers.ts';
import { FREE_DOMAINS, DISPOSABLE_DOMAINS } from './data/consumer-domains.ts';

export function normalizeDomain(raw: string): string {
    if (!raw) return '';
    let s = raw.trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (s.includes('@')) s = s.split('@').pop() ?? '';
    return s.replace(/\.$/, '');
}

export function isValidDomain(domain: string): boolean {
    return (
        /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) &&
        !domain.endsWith('-') &&
        domain.length <= 253
    );
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
    const order: Record<string, number> = { gateway: 0, forwarder: 1, parking: 2, relay: 3, mailbox: 4, consumer: 5 };
    return [...seen.values()].sort((a, b) => order[a.provider.category]! - order[b.provider.category]!);
}

export function consumerLookup(domain: string): ConsumerHit | null {
    if (DISPOSABLE_DOMAINS.has(domain)) return { kind: 'disposable', domain };
    if (FREE_DOMAINS.has(domain))       return { kind: 'free',       domain };
    return null;
}
