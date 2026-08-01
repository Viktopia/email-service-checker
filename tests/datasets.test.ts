import { describe, expect, test } from 'bun:test';
import { SHARD_COUNT, shardIdFor } from '../src/consumer-shards.ts';
import { DATASET_FILES, DATASET_SOURCES, type DatasetKind, parseDatasetText } from '../src/datasets.ts';

const KINDS = Object.keys(DATASET_FILES) as DatasetKind[];

// Two kinds of dataset with two different guarantees. A fetched list is
// rewritten wholesale by `bun run datasets`, so it must round-trip byte for
// byte. A curated list is edited by hand and carries a comment header
// explaining what belongs in it, so byte-equality is the wrong assertion; what
// must hold is that its domain lines are sorted, deduplicated and valid.
const FETCHED_KINDS = KINDS.filter((k) => DATASET_SOURCES[k]);
const CURATED_KINDS = KINDS.filter((k) => !DATASET_SOURCES[k]);

async function readList(kind: DatasetKind): Promise<string[]> {
    return parseDatasetText(await Bun.file(DATASET_FILES[kind]).text());
}

describe('parseDatasetText', () => {
    test('drops comments, blanks and surrounding whitespace', () => {
        expect(parseDatasetText('# comment\n\n  gmail.com  \nyahoo.com\n')).toEqual([
            'gmail.com',
            'yahoo.com',
        ]);
    });

    test('lowercases', () => {
        expect(parseDatasetText('GMAIL.COM')).toEqual(['gmail.com']);
    });

    test('deduplicates and sorts, which is what keeps the committed files diffable', () => {
        expect(parseDatasetText('b.com\na.com\nb.com\n')).toEqual(['a.com', 'b.com']);
    });

    test('rejects lines that are not plain domains', () => {
        expect(parseDatasetText('not a domain\nhttp://x.com\n@x.com\nlocalhost\nok.com')).toEqual(['ok.com']);
    });

    test('keeps punycode, so IDNs survive', () => {
        expect(parseDatasetText('xn--bcher-kva.de')).toEqual(['xn--bcher-kva.de']);
    });
});

describe('shardIdFor', () => {
    test('is a two-character lowercase hex id', () => {
        for (const d of ['gmail.com', 'a.io', 'very-long-domain-name.example.co.uk']) {
            expect(shardIdFor(d)).toMatch(/^[0-9a-f]{2}$/);
        }
    });

    test('is stable across calls', () => {
        expect(shardIdFor('gmail.com')).toBe(shardIdFor('gmail.com'));
    });

    test('spreads the real datasets across every shard', async () => {
        const all = (await Promise.all(KINDS.map(readList))).flat();
        const counts = new Map<string, number>();
        for (const d of all) counts.set(shardIdFor(d), (counts.get(shardIdFor(d)) ?? 0) + 1);

        // An empty shard would mean a 404 for any domain hashing to it, and a
        // wildly hot shard would undo the point of sharding at all.
        expect(counts.size).toBe(SHARD_COUNT);
        const largest = Math.max(...counts.values());
        expect(largest).toBeLessThan((all.length / SHARD_COUNT) * 3);
    });
});

describe('the committed datasets', () => {
    test.each(FETCHED_KINDS)('%s is present and non-trivial', async (kind) => {
        const list = await readList(kind);
        expect(list.length).toBeGreaterThan(1000);
    });

    test.each(CURATED_KINDS)('%s is present and not empty', async (kind) => {
        // A curated list is small by nature, but an empty one means the file
        // was truncated rather than deliberately emptied.
        const list = await readList(kind);
        expect(list.length).toBeGreaterThan(5);
    });

    test.each(FETCHED_KINDS)('%s is already normalised, so the build is a no-op over it', async (kind) => {
        const raw = await Bun.file(DATASET_FILES[kind]).text();
        // Round-tripping must not reorder or drop anything: if it does, the
        // file was hand-edited rather than written by `bun run datasets`.
        expect(raw).toBe(`${parseDatasetText(raw).join('\n')}\n`);
    });

    test.each(CURATED_KINDS)('%s has sorted, deduplicated, valid domain lines', async (kind) => {
        // The same guarantee the fetched lists get, minus the comment header
        // that a hand-maintained file is allowed to carry.
        const list = await readList(kind);
        expect(list).toEqual([...new Set(list)].sort());
        for (const d of list) expect(d).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    });

    test('the curated list does not overlap the fetched ones at all', async () => {
        // The fetched lists tolerate a small mutual overlap (see below): they
        // come from separate upstreams that occasionally disagree, and that is
        // not ours to fix. The curated list is ours, so an overlap there is an
        // editing mistake and should be zero. consumerLookup reports the first
        // match in the order disposable, alias, free, so an overlap would
        // silently decide what the user is told.
        const fetched = new Set((await Promise.all(FETCHED_KINDS.map(readList))).flat());
        for (const kind of CURATED_KINDS) {
            const clashes = (await readList(kind)).filter((d) => fetched.has(d));
            expect(clashes).toEqual([]);
        }
    });

    test('the two big lists do not contradict each other', async () => {
        const [free, disposable] = await Promise.all([readList('free'), readList('disposable')]);
        const both = free.filter((d) => new Set(disposable).has(d));
        // consumerLookup checks disposable first, so an overlap is reported as
        // disposable. Recorded here so a growing overlap is visible rather
        // than silently changing what users are told.
        expect(both.length).toBeLessThan(free.length * 0.05);
    });
});

describe('the alias dataset', () => {
    // An alias domain is one an alias service hands addresses out ON, so mail
    // to it forwards to a mailbox the owner keeps private. The distinction that
    // matters to a caller: it is neither a throwaway (disposable) nor an
    // account someone logs into (free).
    test('covers the alias services people actually receive mail on', async () => {
        const list = new Set(await readList('alias'));
        for (const d of [
            'duck.com', // DuckDuckGo Email Protection
            'mozmail.com', // Firefox Relay
            'privaterelay.appleid.com', // Apple Hide My Email
            'simplelogin.com',
            'addy.io',
        ]) {
            expect(list.has(d)).toBe(true);
        }
    });

    test('excludes the corporate domains of forwarding companies', async () => {
        const list = new Set(await readList('alias'));
        // Both were checked and rejected: their apex MX points at Google
        // Workspace because that is where the company's own mail goes, and
        // 33Mail's real aliases live on *.33mail.com subdomains that
        // exact-domain matching cannot see anyway. Listing either would tell
        // someone their address is an alias when it is a normal mailbox.
        expect(list.has('33mail.com')).toBe(false);
        expect(list.has('improvmx.com')).toBe(false);
    });
});
