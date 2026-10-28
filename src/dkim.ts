/**
 * DKIM public key records (RFC 6376, RFC 8301, RFC 8463), in the browser.
 *
 * A DKIM key lives at <selector>._domainkey.<domain>, and DNS offers no way
 * to list the selectors a domain uses: they appear only in the
 * DKIM-Signature header of mail it sent. So the checker works two ways. Given
 * a selector, it checks that key. Without one, it tries the selectors the
 * common mail services use, and says plainly that finding none proves
 * nothing.
 *
 * What it can check from DNS: the record parses, the key is present and not
 * revoked, the key type, an RSA key's length, testing mode, and whether only
 * SHA-1 is allowed. What it cannot check is that mail is actually signed with
 * the key; that needs a message.
 */

import type { Check } from './checks.ts';
import { parseTxtData, type Resolve } from './dns.ts';
import { isValidSelector } from './identify.ts';
import { parseTagList, type TagList, tagValue } from './tags.ts';

/**
 * Selectors used by widely deployed mail services, tried when none is given.
 * Kept short: each one is a DNS query, and this is a guess, not a scan.
 */
export const COMMON_SELECTORS = [
    'google', // Google Workspace
    'selector1', // Microsoft 365
    'selector2', // Microsoft 365
    'default',
    'dkim',
    'mail',
    'k1', // Mailchimp, Mailgun
    'k2',
    'k3',
    's1', // SendGrid
    's2',
    'smtp', // Mailgun
    'mandrill', // Mailchimp Transactional
    'sig1', // iCloud custom domains
    'fm1', // Fastmail
    'fm2',
    'fm3',
    'protonmail', // Proton
    'protonmail2',
    'protonmail3',
    'zoho', // Zoho
    'zmail',
    'mxvault',
    'everlytickey1',
    'cm', // Campaign Monitor
] as const;

export { isValidSelector };

export interface DkimKey {
    selector: string;
    name: string;
    record: string;
    parsed: TagList;
    keyType: string;
    /** RSA modulus length in bits, when it could be read. */
    bits: number | null;
    revoked: boolean;
}

export interface DkimReport {
    domain: string;
    /** The selector asked for, or null when common ones were tried. */
    selector: string | null;
    keys: DkimKey[];
    tried: string[];
    checks: Check[];
}

function base64Bytes(b64: string): Uint8Array | null {
    const clean = b64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
    try {
        const bin = atob(clean);
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

/** Reads one DER TLV at `at`: its tag, and where its contents start and end. */
function der(bytes: Uint8Array, at: number): { tag: number; start: number; end: number } | null {
    if (at + 2 > bytes.length) return null;
    const tag = bytes[at]!;
    let len = bytes[at + 1]!;
    let start = at + 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        if (n === 0 || n > 4 || start + n > bytes.length) return null;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + bytes[start + i]!;
        start += n;
    }
    const end = start + len;
    return end <= bytes.length ? { tag, start, end } : null;
}

/** Bit length of a DER INTEGER's value, ignoring the sign-padding zero byte. */
function integerBits(bytes: Uint8Array, tlv: { start: number; end: number }): number {
    let i = tlv.start;
    while (i < tlv.end && bytes[i] === 0) i++;
    if (i === tlv.end) return 0;
    return (tlv.end - i - 1) * 8 + (32 - Math.clz32(bytes[i]!));
}

/**
 * The modulus length of an RSA key in a DKIM p= tag.
 *
 * p= is normally a SubjectPublicKeyInfo; a few signers publish the bare
 * PKCS#1 RSAPublicKey instead, and receivers accept both, so both are read.
 */
export function rsaKeyBits(b64: string): number | null {
    const bytes = base64Bytes(b64);
    if (!bytes || bytes.length === 0) return null;
    const outer = der(bytes, 0);
    if (outer?.tag !== 0x30) return null;
    const first = der(bytes, outer.start);
    if (!first) return null;

    // PKCS#1: SEQUENCE { INTEGER modulus, INTEGER exponent }
    if (first.tag === 0x02) return integerBits(bytes, first);

    // SPKI: SEQUENCE { SEQUENCE algorithm, BIT STRING { RSAPublicKey } }
    if (first.tag !== 0x30) return null;
    const bitString = der(bytes, first.end);
    if (bitString?.tag !== 0x03) return null;
    const inner = der(bytes, bitString.start + 1); // skip the unused-bits byte
    if (inner?.tag !== 0x30) return null;
    const modulus = der(bytes, inner.start);
    return modulus && modulus.tag === 0x02 ? integerBits(bytes, modulus) : null;
}

export function parseDkimKey(selector: string, name: string, record: string): DkimKey {
    const parsed = parseTagList(record);
    const keyType = (tagValue(parsed, 'k') ?? 'rsa').toLowerCase();
    const p = tagValue(parsed, 'p');
    const revoked = p !== undefined && p.replace(/\s+/g, '') === '';
    const bits = keyType === 'rsa' && p && !revoked ? rsaKeyBits(p) : null;
    return { selector, name, record, parsed, keyType, bits, revoked };
}

function keyChecks(key: DkimKey, prefix: string): Check[] {
    const checks: Check[] = [];
    const errors = [...key.parsed.errors];
    const v = tagValue(key.parsed, 'v');
    if (v !== undefined && (key.parsed.tags[0]?.name !== 'v' || v !== 'DKIM1')) {
        errors.push('If v= is present it must be the first tag and exactly "DKIM1".');
    }
    const p = tagValue(key.parsed, 'p');
    if (p === undefined) errors.push('p= (the public key) is required.');
    if (!['rsa', 'ed25519'].includes(key.keyType))
        errors.push(`k=${key.keyType} is not a key type receivers support.`);
    if (key.keyType === 'rsa' && p && !key.revoked && key.bits === null) {
        errors.push('p= is not a readable RSA public key.');
    }
    if (key.keyType === 'ed25519' && p && !key.revoked && base64Bytes(p)?.length !== 32) {
        errors.push('An Ed25519 p= must be a 32-byte key.');
    }

    checks.push(
        errors.length > 0
            ? {
                  id: 'dkim-syntax',
                  status: 'fail',
                  title: `${prefix}Key record is invalid`,
                  detail: errors.join(' '),
              }
            : {
                  id: 'dkim-syntax',
                  status: 'pass',
                  title: `${prefix}Key record is valid`,
                  detail: `Published at ${key.name}.`,
              },
    );

    if (key.revoked) {
        checks.push({
            id: 'dkim-revoked',
            status: 'warn',
            title: `${prefix}Key revoked`,
            detail: 'p= is empty, which revokes the key: signatures made with it fail. That is correct for a retired selector, and a problem if anything still signs with it.',
        });
    } else if (key.keyType === 'ed25519') {
        checks.push({
            id: 'dkim-key-strength',
            status: 'pass',
            title: `${prefix}Ed25519 key`,
            detail: 'Ed25519 (RFC 8463) is strong and compact. Not every receiver verifies it yet, so it is usually published alongside an RSA key under a second selector.',
        });
    } else if (key.bits !== null) {
        checks.push(
            key.bits < 1024
                ? {
                      id: 'dkim-key-strength',
                      status: 'fail',
                      title: `${prefix}${key.bits}-bit RSA key`,
                      detail: 'RFC 8301 says receivers must not accept RSA keys shorter than 1024 bits, so these signatures will be ignored. Generate a 2048-bit key.',
                  }
                : key.bits < 2048
                  ? {
                        id: 'dkim-key-strength',
                        status: 'warn',
                        title: `${prefix}${key.bits}-bit RSA key`,
                        detail: 'Still accepted, but 1024-bit RSA is considered weak, and RFC 8301 asks signers to use at least 2048 bits. Rotate to a 2048-bit key under a new selector.',
                    }
                  : {
                        id: 'dkim-key-strength',
                        status: 'pass',
                        title: `${prefix}${key.bits}-bit RSA key`,
                        detail: 'Meets the 2048-bit recommendation of RFC 8301.',
                    },
        );
    }

    const t = tagValue(key.parsed, 't')?.toLowerCase() ?? '';
    if (t.split(':').some((f) => f.trim() === 'y')) {
        checks.push({
            id: 'dkim-testing',
            status: 'warn',
            title: `${prefix}Testing mode (t=y)`,
            detail: 'Receivers are asked to treat signatures from this key as unsigned mail. Remove t=y once signing works.',
        });
    }

    const h = tagValue(key.parsed, 'h');
    if (h && !h.split(':').some((a) => a.trim().toLowerCase() === 'sha256')) {
        checks.push({
            id: 'dkim-hash',
            status: 'fail',
            title: `${prefix}Only allows h=${h}`,
            detail: 'RFC 8301 forbids rsa-sha1 signatures, so a key restricted to SHA-1 cannot produce one receivers accept. Remove h= or include sha256.',
        });
    }

    return checks;
}

/**
 * Whether a TXT string is a DKIM key record rather than something else that
 * happens to sit at the name. Wildcard TXT records are common — *.example.com
 * carrying the SPF or DMARC record — and every selector then "has" one.
 */
export function isDkimRecord(txt: string): boolean {
    const t = txt.trim();
    if (/^v\s*=/i.test(t)) return /^v\s*=\s*DKIM1\s*(;|$)/i.test(t);
    return /(^|;)\s*p\s*=/i.test(t);
}

async function fetchKey(resolve: Resolve, domain: string, selector: string): Promise<DkimKey[] | null> {
    const name = `${selector}._domainkey.${domain}`;
    const res = await resolve(name, 'TXT');
    const records = res.answers.map((a) => parseTxtData(a.data)).filter(isDkimRecord);
    if (records.length === 0) return null;
    return records.map((r) => parseDkimKey(selector, name, r));
}

export async function checkDkim(
    domain: string,
    selector: string | null,
    resolve: Resolve,
): Promise<DkimReport> {
    const checks: Check[] = [];
    const tried = selector ? [selector] : [...COMMON_SELECTORS];
    // When guessing, also ask for a selector nobody would use. Anything it
    // returns comes from a wildcard, and keys identical to it are not real.
    const probe = selector ? null : `esc-wildcard-probe-${Math.random().toString(36).slice(2, 10)}`;
    const [wildcard, ...found] = await Promise.all([
        probe ? fetchKey(resolve, domain, probe).catch(() => null) : Promise.resolve(null),
        ...tried.map((s) => fetchKey(resolve, domain, s).catch(() => null)),
    ]);
    const wildcardRecords = new Set((wildcard ?? []).map((k) => k.record));
    const keys = found.flatMap((k) => k ?? []).filter((k) => !wildcardRecords.has(k.record));
    const report: DkimReport = { domain, selector, keys, tried, checks };
    if (wildcard && wildcard.length > 0) {
        // A wildcard of revoked keys ("v=DKIM1; p=") is deliberate: it is how
        // a domain that sends no mail says no selector is valid.
        checks.push(
            wildcard.every((k) => k.revoked)
                ? {
                      id: 'dkim-wildcard',
                      status: 'info',
                      title: 'Every selector is revoked',
                      detail: `A wildcard at *._domainkey.${domain} publishes an empty key, so a signature with any selector fails. That is the right setup for a domain that sends no mail.`,
                  }
                : {
                      id: 'dkim-wildcard',
                      status: 'warn',
                      title: 'Wildcard DKIM key',
                      detail: `Every name under _domainkey.${domain} returns the same key, from a wildcard record. Signatures with any selector will verify against it, which is rarely intended. Publish keys per selector instead.`,
                  },
        );
    }

    if (keys.length === 0) {
        checks.push(
            selector
                ? {
                      id: 'dkim-published',
                      status: 'fail',
                      title: 'No DKIM key at this selector',
                      detail: `Nothing that looks like a DKIM key is published at ${selector}._domainkey.${domain}. Check the selector against the s= value in a DKIM-Signature header of a message the domain sent.`,
                  }
                : {
                      id: 'dkim-published',
                      status: 'manual',
                      title: 'No key found at common selectors',
                      detail: `None of the ${tried.length} selectors that common mail services use has a key for ${domain}. That does not mean the domain does not sign mail: selectors cannot be listed from DNS. Find yours in the s= value of the DKIM-Signature header of a message the domain sent, and check it here.`,
                  },
        );
        return report;
    }

    const bySelector = new Map<string, DkimKey[]>();
    for (const k of keys) bySelector.set(k.selector, [...(bySelector.get(k.selector) ?? []), k]);

    checks.push({
        id: 'dkim-published',
        status: 'pass',
        title: selector
            ? 'DKIM key published'
            : `Found ${bySelector.size} selector${bySelector.size === 1 ? '' : 's'}`,
        detail: selector
            ? `A key is published at ${selector}._domainkey.${domain}.`
            : `Keys found at ${[...bySelector.keys()].map((s) => `${s}._domainkey`).join(', ')}. Other selectors may exist; DNS cannot list them.`,
    });

    for (const [sel, list] of bySelector) {
        const prefix = bySelector.size > 1 || !selector ? `${sel}: ` : '';
        if (list.length > 1) {
            checks.push({
                id: 'dkim-multiple',
                status: 'fail',
                title: `${prefix}Multiple key records`,
                detail: `${list[0]!.name} has ${list.length} TXT records that look like DKIM keys. Receivers may pick either one, so signatures fail at random. Keep one.`,
            });
        }
        checks.push(...keyChecks(list[0]!, prefix));
    }

    checks.push({
        id: 'dkim-signing',
        status: 'manual',
        title: 'Signing not verified',
        detail: 'A published key shows the domain can sign, not that its mail is signed with it. Send yourself a message and look for dkim=pass with header.d= this domain in the Authentication-Results header.',
    });

    return report;
}
