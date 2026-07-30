import { afterEach, describe, expect, test } from 'bun:test';
import { LookupError, lookupMx } from '../src/lookup.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Records which resolver hosts were called, and answers per a scripted plan. */
function mockResolvers(plan: (host: string) => Response | Promise<Response>): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        calls.push(url.host);
        return plan(url.host);
    }) as typeof fetch;
    return calls;
}

const dnsJson = (answer: unknown[]) =>
    new Response(JSON.stringify({ Status: 0, Answer: answer }), {
        headers: { 'content-type': 'application/dns-json' },
    });

const mx = (data: string) => ({ name: 'example.com', type: 15, TTL: 300, data });

describe('lookupMx', () => {
    test('parses priority and host, and lowercases and strips the trailing dot', async () => {
        mockResolvers(() => dnsJson([mx('10 MX.Example.COM.')]));
        expect(await lookupMx('example.com')).toEqual([{ priority: 10, host: 'mx.example.com' }]);
    });

    test('sorts by priority', async () => {
        mockResolvers(() =>
            dnsJson([mx('50 c.example.com.'), mx('10 a.example.com.'), mx('20 b.example.com.')]),
        );
        const hosts = (await lookupMx('example.com')).map((r) => r.host);
        expect(hosts).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
    });

    test('ignores non-MX answers', async () => {
        mockResolvers(() =>
            dnsJson([
                { name: 'example.com', type: 5, TTL: 300, data: 'cname.example.com.' },
                mx('10 mx.example.com.'),
            ]),
        );
        expect(await lookupMx('example.com')).toEqual([{ priority: 10, host: 'mx.example.com' }]);
    });

    test('treats a record with no priority as priority 0', async () => {
        mockResolvers(() => dnsJson([mx('mx.example.com.')]));
        expect(await lookupMx('example.com')).toEqual([{ priority: 0, host: 'mx.example.com' }]);
    });

    test('returns nothing when the domain has no MX records', async () => {
        mockResolvers(() => new Response(JSON.stringify({ Status: 0 })));
        expect(await lookupMx('example.com')).toEqual([]);
    });

    test('queries only the first resolver when it succeeds', async () => {
        const calls = mockResolvers(() => dnsJson([mx('10 mx.example.com.')]));
        await lookupMx('example.com');
        expect(calls).toEqual(['dns.google']);
    });

    test('falls back to the next resolver when the first is blocked', async () => {
        // A blocked resolver rejects rather than returning a status.
        const calls = mockResolvers((host) => {
            if (host === 'dns.google') return Promise.reject(new TypeError('Failed to fetch'));
            return dnsJson([mx('10 mx.example.com.')]);
        });
        expect(await lookupMx('example.com')).toEqual([{ priority: 10, host: 'mx.example.com' }]);
        expect(calls).toEqual(['dns.google', 'cloudflare-dns.com']);
    });

    test('falls back when the first resolver returns an error status', async () => {
        const calls = mockResolvers((host) =>
            host === 'dns.google'
                ? new Response('nope', { status: 502 })
                : dnsJson([mx('5 mx.example.com.')]),
        );
        expect(await lookupMx('example.com')).toEqual([{ priority: 5, host: 'mx.example.com' }]);
        expect(calls).toHaveLength(2);
    });

    test('throws LookupError naming every resolver when all fail', async () => {
        mockResolvers(() => Promise.reject(new TypeError('Failed to fetch')));
        const err = await lookupMx('example.com').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LookupError);
        expect((err as LookupError).message).toContain('Google');
        expect((err as LookupError).message).toContain('Cloudflare');
    });

    test('encodes the domain into the query rather than interpolating it raw', async () => {
        let seen = '';
        globalThis.fetch = (async (input: string | URL | Request) => {
            seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            return dnsJson([]);
        }) as typeof fetch;
        await lookupMx('a b&type=A');
        expect(seen).toContain('name=a%20b%26type%3DA');
    });
});
