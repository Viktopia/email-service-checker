import { describe, expect, test } from 'bun:test';
import { SHARD_COUNT, shardIdFor } from '../src/consumer-shards.ts';
import { DATASET_FILES, type DatasetKind, parseDatasetText } from '../src/datasets.ts';

const KINDS = Object.keys(DATASET_FILES) as DatasetKind[];

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
    test.each(KINDS)('%s is present and non-trivial', async (kind) => {
        const list = await readList(kind);
        expect(list.length).toBeGreaterThan(1000);
    });

    test.each(KINDS)('%s is already normalised, so the build is a no-op over it', async (kind) => {
        const raw = await Bun.file(DATASET_FILES[kind]).text();
        // Round-tripping must not reorder or drop anything: if it does, the
        // file was hand-edited rather than written by `bun run datasets`.
        expect(raw).toBe(`${parseDatasetText(raw).join('\n')}\n`);
    });

    test('the two lists do not contradict each other', async () => {
        const [free, disposable] = await Promise.all([readList('free'), readList('disposable')]);
        const both = free.filter((d) => new Set(disposable).has(d));
        // consumerLookup checks disposable first, so an overlap is reported as
        // disposable. Recorded here so a growing overlap is visible rather
        // than silently changing what users are told.
        expect(both.length).toBeLessThan(free.length * 0.05);
    });
});
