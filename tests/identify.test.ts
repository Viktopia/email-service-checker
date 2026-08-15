import { describe, expect, test } from 'bun:test';
import { identifyProviders, isValidDomain, normalizeDomain } from '../src/identify.ts';
import { CATEGORY_LABEL, PROVIDERS, providerSlug } from '../src/providers.ts';
import type { MxRecord } from '../src/types.ts';

const mx = (host: string, priority = 10): MxRecord => ({ host, priority });

describe('normalizeDomain', () => {
    test.each([
        ['Example.COM', 'example.com'],
        ['  example.com  ', 'example.com'],
        ['https://example.com/path?q=1', 'example.com'],
        ['http://example.com', 'example.com'],
        ['you@example.com', 'example.com'],
        ['First.Last@Sub.Example.com', 'sub.example.com'],
        ['example.com.', 'example.com'],
        ['', ''],
    ])('%j → %j', (input, expected) => {
        expect(normalizeDomain(input)).toBe(expected);
    });
});

describe('isValidDomain', () => {
    test.each([
        'example.com',
        'sub.example.co.uk',
        'xn--bcher-kva.example',
        'a-b.example.com',
        '1.example.com',
    ])('accepts %j', (domain) => {
        expect(isValidDomain(domain)).toBe(true);
    });

    test.each([
        'example',
        '',
        '-example.com',
        'example-.com',
        // Only the first character was guarded before, so this used to pass.
        'foo.-bar.com',
        'foo.bar-.com',
        'example..com',
        'example.c',
        'example.com2',
        'exa mple.com',
        `${'a'.repeat(250)}.example.com`,
    ])('rejects %j', (domain) => {
        expect(isValidDomain(domain)).toBe(false);
    });
});

describe('identifyProviders', () => {
    test('matches an exact MX host', () => {
        const [finding] = identifyProviders([mx('aspmx.l.google.com')]);
        expect(finding?.provider.name).toBe('Google Workspace');
    });

    test('matches a subdomain of a matcher', () => {
        const [finding] = identifyProviders([mx('alt1.aspmx.l.google.com')]);
        expect(finding?.provider.name).toBe('Google Workspace');
    });

    test('consumer Gmail is not reported as Google Workspace', () => {
        // gmail.com publishes gmail-smtp-in.l.google.com, which also ends in
        // Google Workspace's broad '.google.com' matcher. The longer Gmail
        // matcher has to win, or every consumer Gmail address reads as a
        // business mailbox provider.
        const [finding] = identifyProviders([
            mx('gmail-smtp-in.l.google.com', 5),
            mx('alt1.gmail-smtp-in.l.google.com', 10),
        ]);
        expect(finding?.provider.name).toBe('Gmail');
        expect(finding?.provider.category).toBe('consumer');
        expect(finding?.matchedMx).toHaveLength(2);
    });

    test('does not match a suffix that is not on a label boundary', () => {
        // "mail.com" must not match "googlemail.com" — the documented contract
        // of the dot-suffix rule in providers.ts.
        expect(identifyProviders([mx('notgooglemail.com')])).toEqual([]);
    });

    test('longest matcher wins over a broader one', () => {
        // Microsoft 365 lists both "outlook.com" and the longer
        // "mail.protection.outlook.com"; a gateway hostname under a more
        // specific matcher must not be reported as the broad match.
        const [finding] = identifyProviders([mx('example-com.mail.protection.outlook.com')]);
        expect(finding?.provider.name).toBe('Microsoft 365');
    });

    test('ignores hosts with no known provider', () => {
        expect(identifyProviders([mx('mx.some-unknown-host.example')])).toEqual([]);
    });

    test('groups several MX records under one provider', () => {
        const findings = identifyProviders([
            mx('aspmx.l.google.com', 1),
            mx('alt1.aspmx.l.google.com', 5),
            mx('alt2.aspmx.l.google.com', 10),
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.matchedMx).toHaveLength(3);
    });

    test('orders a gateway ahead of the mailbox behind it', () => {
        const findings = identifyProviders([mx('mx.example.mimecast.com', 10), mx('aspmx.l.google.com', 20)]);
        expect(findings.map((f) => f.provider.category)).toEqual(['gateway', 'mailbox']);
    });

    test('is case- and trailing-dot-insensitive', () => {
        const [finding] = identifyProviders([mx('ASPMX.L.GOOGLE.COM.')]);
        expect(finding?.provider.name).toBe('Google Workspace');
    });

    test('returns nothing for no records', () => {
        expect(identifyProviders([])).toEqual([]);
    });
});

describe('the provider catalogue', () => {
    test('every provider has at least one matcher', () => {
        const empty = PROVIDERS.filter((p) => p.matchers.length === 0);
        expect(empty.map((p) => p.name)).toEqual([]);
    });

    test('provider names are unique', () => {
        const names = PROVIDERS.map((p) => p.name);
        expect(names).toHaveLength(new Set(names).size);
    });

    test('slugs are unique, since they become page URLs', () => {
        const slugs = PROVIDERS.map(providerSlug);
        const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
        expect(dupes).toEqual([]);
    });

    test('slugs are URL-safe and non-empty', () => {
        for (const p of PROVIDERS) {
            expect(providerSlug(p)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        }
    });

    test('matchers are lowercase and carry no leading dot or trailing dot', () => {
        for (const p of PROVIDERS) {
            for (const m of p.matchers) {
                expect(m).toBe(m.toLowerCase());
                expect(m.startsWith('.')).toBe(false);
                expect(m.endsWith('.')).toBe(false);
            }
        }
    });

    test('no matcher is claimed by two different providers', () => {
        const owner = new Map<string, string>();
        const clashes: string[] = [];
        for (const p of PROVIDERS) {
            for (const m of p.matchers) {
                const existing = owner.get(m);
                if (existing && existing !== p.name) clashes.push(`${m}: ${existing} vs ${p.name}`);
                owner.set(m, p.name);
            }
        }
        expect(clashes).toEqual([]);
    });

    test('every category used has a display label', () => {
        for (const p of PROVIDERS) {
            expect(CATEGORY_LABEL[p.category]).toBeTruthy();
        }
    });
});
