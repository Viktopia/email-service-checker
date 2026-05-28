import type { MxRecord } from './types.ts';

interface DnsAnswer {
    name: string;
    type: number;
    TTL: number;
    data: string;
}

interface DnsResponse {
    Status: number;
    Answer?: DnsAnswer[];
}

export class LookupError extends Error {
    constructor(message: string, public cause?: unknown) {
        super(message);
        this.name = 'LookupError';
    }
}

function parseMx(answer: DnsAnswer): MxRecord {
    // Cloudflare and Google both return "10 mx.example.com." in `data`
    const parts = answer.data.trim().split(/\s+/);
    const priority = parts.length > 1 ? Number.parseInt(parts[0]!, 10) : 0;
    const host = (parts.length > 1 ? parts[1]! : parts[0]!).replace(/\.$/, '').toLowerCase();
    return { priority, host };
}

export async function lookupMx(domain: string): Promise<MxRecord[]> {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`;
    let res: Response;
    try {
        res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    } catch (err) {
        throw new LookupError('Network error during DNS lookup', err);
    }
    if (!res.ok) throw new LookupError(`DNS request failed (${res.status})`);
    const data = (await res.json()) as DnsResponse;
    if (!data.Answer) return [];
    return data.Answer
        .filter(a => a.type === 15) // MX
        .map(parseMx)
        .sort((a, b) => a.priority - b.priority);
}
