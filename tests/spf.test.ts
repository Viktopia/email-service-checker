import { describe, expect, test } from 'bun:test';
import { parseTxtData } from '../src/dns.ts';
import { checkSpf, isIPv4, isIPv6, parseSpf, validateDomainSpec } from '../src/spf.ts';
import { fakeResolver, type Zone } from './zone.ts';

const status = (checks: { id: string; status: string }[], id: string) =>
    checks.find((c) => c.id === id)?.status;

describe('parseTxtData', () => {
    test('passes Google-style unquoted data through', () => {
        expect(parseTxtData('v=spf1 -all')).toBe('v=spf1 -all');
    });
    test('joins Cloudflare-style quoted strings without a separator', () => {
        expect(parseTxtData('"v=spf1 include:a.example" " -all"')).toBe('v=spf1 include:a.example -all');
    });
    test('unescapes quotes and decimal escapes', () => {
        expect(parseTxtData('"a\\"b\\059c"')).toBe('a"b;c');
    });
});

describe('address validation', () => {
    test.each(['192.0.2.1', '0.0.0.0', '255.255.255.255'])('accepts IPv4 %s', (ip) => {
        expect(isIPv4(ip)).toBe(true);
    });
    test.each(['256.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5'])('rejects IPv4 %s', (ip) => {
        expect(isIPv4(ip)).toBe(false);
    });
    test.each(['2001:db8::1', '::1', '::', '2001:db8:0:0:0:0:0:1', '::ffff:192.0.2.1'])(
        'accepts IPv6 %s',
        (ip) => {
            expect(isIPv6(ip)).toBe(true);
        },
    );
    test.each(['2001:db8:::1', '1:2:3:4:5:6:7:8:9', 'g::1', '2001:db8::1::2'])('rejects IPv6 %s', (ip) => {
        expect(isIPv6(ip)).toBe(false);
    });
});

describe('validateDomainSpec', () => {
    test('accepts plain domains and macros', () => {
        expect(validateDomainSpec('_spf.example.com')).toBeNull();
        expect(validateDomainSpec('%{i}._spf.example.com')).toBeNull();
        expect(validateDomainSpec('%{ir}.%{v}._spf.%{d2}')).toBeNull();
    });
    test('rejects single labels, bad macros and explanation-only letters', () => {
        expect(validateDomainSpec('localhost')).not.toBeNull();
        expect(validateDomainSpec('%{x}.example.com')).not.toBeNull();
        expect(validateDomainSpec('%{c}.example.com')).not.toBeNull();
        expect(validateDomainSpec('%{i.example.com')).not.toBeNull();
    });
});

describe('parseSpf', () => {
    test('reads qualifiers, mechanisms and modifiers', () => {
        const { terms, errors } = parseSpf(
            'v=spf1 ip4:192.0.2.0/24 -mx:mail.example.com/24 ~include:_spf.example.net redirect=_spf.example.com',
        );
        expect(errors).toEqual([]);
        expect(terms.map((t) => [t.qualifier, t.name, t.value, t.cidr])).toEqual([
            ['+', 'ip4', '192.0.2.0', '/24'],
            ['-', 'mx', 'mail.example.com', '/24'],
            ['~', 'include', '_spf.example.net', ''],
            ['+', 'redirect', '_spf.example.com', ''],
        ]);
    });
    test('accepts dual CIDR lengths', () => {
        expect(parseSpf('v=spf1 a/24//64 mx//48 -all').errors).toEqual([]);
    });
    test.each([
        ['an unknown mechanism', 'v=spf1 include _spf.example.com -all'],
        ['a bad IPv4', 'v=spf1 ip4:300.1.1.1 -all'],
        ['a bad prefix', 'v=spf1 ip4:192.0.2.0/33 -all'],
        ['include without domain', 'v=spf1 include -all'],
        ['all with an argument', 'v=spf1 all:example.com'],
        ['a duplicate redirect', 'v=spf1 redirect=a.example redirect=b.example'],
        ['a wrong version', 'v=spf2 -all'],
        ['smart quotes pasted from a document', 'v=spf1 include:_spf.example.com “-all”'],
    ])('flags %s', (_, record) => {
        expect(parseSpf(record).errors.length).toBeGreaterThan(0);
    });
});

describe('checkSpf', () => {
    test('a simple, correct record passes', async () => {
        const zone: Zone = { 'example.com': { TXT: ['v=spf1 ip4:192.0.2.1 -all'] } };
        const r = await checkSpf('example.com', fakeResolver(zone));
        expect(r.lookups).toBe(0);
        expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
    });

    test('reports a missing record', async () => {
        const r = await checkSpf(
            'example.com',
            fakeResolver({ 'example.com': { TXT: ['google-site-verification=x'] } }),
        );
        expect(status(r.checks, 'spf-published')).toBe('fail');
    });

    test('reports multiple records', async () => {
        const r = await checkSpf(
            'example.com',
            fakeResolver({ 'example.com': { TXT: ['v=spf1 -all', 'v=spf1 include:x.example -all'] } }),
        );
        expect(status(r.checks, 'spf-multiple')).toBe('fail');
    });

    test('counts lookups across nested includes, and fails past ten', async () => {
        const zone: Zone = {
            'example.com': { TXT: ['v=spf1 include:a.example include:b.example -all'] },
            'a.example': { TXT: ['v=spf1 include:c.example include:d.example include:e.example ~all'] },
            'b.example': {
                TXT: ['v=spf1 include:f.example include:g.example include:h.example include:i.example ~all'],
            },
        };
        for (const n of 'cdefghi')
            zone[`${n}.example`] = { TXT: ['v=spf1 ip4:192.0.2.1 a:host.example ~all'] };
        zone['host.example'] = { A: ['192.0.2.2'] };
        const r = await checkSpf('example.com', fakeResolver(zone));
        // 2 at the root, 3 + 4 nested includes, and 7 a: terms.
        expect(r.lookups).toBe(16);
        expect(status(r.checks, 'spf-lookups')).toBe('fail');
        expect(r.tree?.totalLookups).toBe(16);
    });

    test('an include of a domain without SPF is a permanent error and a void lookup', async () => {
        const zone: Zone = {
            'example.com': { TXT: ['v=spf1 include:gone.example -all'] },
            'gone.example': { TXT: [] },
        };
        const r = await checkSpf('example.com', fakeResolver(zone));
        expect(status(r.checks, 'spf-syntax')).toBe('fail');
        expect(r.voidLookups).toBe(1);
    });

    test('more than two void lookups fails', async () => {
        const zone: Zone = {
            'example.com': { TXT: ['v=spf1 a:x.example a:y.example mx:z.example -all'] },
        };
        const r = await checkSpf('example.com', fakeResolver(zone));
        expect(r.voidLookups).toBe(3);
        expect(status(r.checks, 'spf-void-lookups')).toBe('fail');
    });

    test('flags the same include reached twice in the tree', async () => {
        const zone: Zone = {
            'example.com': { TXT: ['v=spf1 include:_spf.example.net include:vendor.example -all'] },
            'vendor.example': { TXT: ['v=spf1 include:_spf.example.net ~all'] },
            '_spf.example.net': { TXT: ['v=spf1 ip4:192.0.2.1 ~all'] },
        };
        const r = await checkSpf('example.com', fakeResolver(zone));
        expect(status(r.checks, 'spf-duplicate-include')).toBe('warn');
        expect(r.lookups).toBe(3);
    });

    test('detects include loops instead of following them', async () => {
        const zone: Zone = {
            'example.com': { TXT: ['v=spf1 include:a.example -all'] },
            'a.example': { TXT: ['v=spf1 include:example.com -all'] },
        };
        const r = await checkSpf('example.com', fakeResolver(zone));
        expect(status(r.checks, 'spf-syntax')).toBe('fail');
        expect(r.checks.find((c) => c.id === 'spf-syntax')?.detail).toContain('Loop');
    });

    test.each([
        ['+all', 'fail'],
        ['?all', 'warn'],
        ['~all', 'pass'],
        ['-all', 'pass'],
    ])('grades a record ending in %s as %s', async (all, expected) => {
        const r = await checkSpf(
            'example.com',
            fakeResolver({ 'example.com': { TXT: [`v=spf1 ip4:192.0.2.1 ${all}`] } }),
        );
        expect(status(r.checks, 'spf-all')).toBe(expected);
    });

    test('takes the final policy from a redirect target', async () => {
        const zone: Zone = {
            'example.com': { TXT: ['v=spf1 redirect=_spf.example.com'] },
            '_spf.example.com': { TXT: ['v=spf1 ip4:192.0.2.1 +all'] },
        };
        const r = await checkSpf('example.com', fakeResolver(zone));
        expect(status(r.checks, 'spf-all')).toBe('fail');
        expect(r.lookups).toBe(1);
    });

    test('warns about ptr, terms after all, and an ignored redirect', async () => {
        const r = await checkSpf(
            'example.com',
            fakeResolver({ 'example.com': { TXT: ['v=spf1 ptr -all ip4:192.0.2.1 redirect=x.example'] } }),
        );
        expect(status(r.checks, 'spf-ptr')).toBe('warn');
        expect(status(r.checks, 'spf-after-all')).toBe('warn');
        expect(status(r.checks, 'spf-redirect-ignored')).toBe('warn');
    });

    test('does not follow macros, and says so', async () => {
        const zone: Zone = { 'example.com': { TXT: ['v=spf1 exists:%{i}._spf.example.com -all'] } };
        const resolver = fakeResolver(zone);
        const r = await checkSpf('example.com', resolver);
        expect(status(r.checks, 'spf-macros')).toBe('info');
        expect(resolver.queries.some((q) => q.includes('%{'))).toBe(false);
    });

    test('flags the retired SPF record type', async () => {
        const r = await checkSpf(
            'example.com',
            fakeResolver({ 'example.com': { TXT: ['v=spf1 -all'], SPF: ['v=spf1 -all'] } }),
        );
        expect(status(r.checks, 'spf-legacy-type')).toBe('info');
    });
});
