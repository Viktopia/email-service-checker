import { type DnsAnswer, resolve } from './dns.ts';
import type { MxRecord } from './types.ts';

export { LookupError } from './dns.ts';

export function parseMx(answer: DnsAnswer): MxRecord {
    // Cloudflare and Google both return "10 mx.example.com." in `data`
    const parts = answer.data.trim().split(/\s+/);
    const priority = parts.length > 1 ? Number.parseInt(parts[0]!, 10) : 0;
    const host = (parts.length > 1 ? parts[1]! : parts[0]!).replace(/\.$/, '').toLowerCase();
    return { priority, host };
}

export async function lookupMx(domain: string): Promise<MxRecord[]> {
    const { answers } = await resolve(domain, 'MX');
    return answers.map(parseMx).sort((a, b) => a.priority - b.priority);
}
