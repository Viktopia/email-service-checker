/**
 * The `tag=value; tag=value` syntax shared by the MTA-STS, TLS-RPT and BIMI
 * DNS records. DMARC uses the same shape but has its own parser in dmarc.ts,
 * because it validates far more of it.
 */

import { parseTxtData, type Resolve } from './dns.ts';

export interface Tag {
    name: string;
    value: string;
}

export interface TagList {
    tags: Tag[];
    errors: string[];
}

export function parseTagList(record: string): TagList {
    const tags: Tag[] = [];
    const errors: string[] = [];
    for (const part of record.split(';')) {
        const p = part.trim();
        if (!p) continue;
        const eq = p.indexOf('=');
        if (eq < 0) {
            errors.push(`"${p}" is not a tag=value pair.`);
            continue;
        }
        const name = p.slice(0, eq).trim().toLowerCase();
        if (tags.some((t) => t.name === name)) {
            errors.push(`The ${name} tag appears more than once.`);
            continue;
        }
        tags.push({ name, value: p.slice(eq + 1).trim() });
    }
    return { tags, errors };
}

export function tagValue(list: TagList, name: string): string | undefined {
    return list.tags.find((t) => t.name === name)?.value;
}

/** Every TXT string at `name` whose text starts with `prefix` (case-insensitive), with NXDOMAIN reported. */
export async function txtRecords(
    resolve: Resolve,
    name: string,
    prefix: RegExp,
): Promise<{ records: string[]; nxdomain: boolean }> {
    const res = await resolve(name, 'TXT');
    return {
        records: res.answers.map((a) => parseTxtData(a.data)).filter((t) => prefix.test(t)),
        nxdomain: res.status === 3,
    };
}
