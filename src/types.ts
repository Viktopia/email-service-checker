export type ProviderCategory =
    | 'mailbox'
    | 'consumer'
    | 'gateway'
    | 'forwarder'
    | 'relay'
    | 'parking';

export interface Provider {
    name: string;
    category: ProviderCategory;
    url?: string;
    matchers: string[];
}

export interface MxRecord {
    priority: number;
    host: string;
}

export interface Finding {
    provider: Provider;
    matchedMx: MxRecord[];
}

export interface ConsumerHit {
    kind: 'free' | 'disposable';
    domain: string;
}

export type LookupOutcome =
    | { kind: 'no-mx'; domain: string; consumerHit: ConsumerHit | null }
    | { kind: 'identified'; domain: string; findings: Finding[]; mxRecords: MxRecord[] }
    | { kind: 'unknown'; domain: string; mxRecords: MxRecord[] };
