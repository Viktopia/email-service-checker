/**
 * Post-build checks against ./dist/
 *
 *   bun run verify
 *
 * Unit tests cover the pure functions; this covers the things that can only go
 * wrong in the generated output, where a failure is silent:
 *
 *   - a domain landing in a different shard from the one the runtime will ask
 *     for, which would quietly stop reporting it as free/disposable
 *   - a page losing its JSON-LD, or emitting invalid JSON-LD
 *   - an unsubstituted {{PLACEHOLDER}} reaching production
 *   - a sitemap URL with no corresponding generated page
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ConsumerShard, SHARD_BASE_PATH, SHARD_COUNT, shardIdFor } from '../src/consumer-shards.ts';
import { DATASET_FILES, type DatasetKind, parseDatasetText, SHARD_KEY } from '../src/datasets.ts';
import { PROVIDERS, providerSlug } from '../src/providers.ts';
import { GUIDES, guideUrl } from './guides.ts';
import { TOOLS, toolUrl } from './tools.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
    checks++;
    if (!ok) fail(`${label}${detail ? `: ${detail}` : ''}`);
}

if (!existsSync(DIST)) {
    console.error('dist/ is missing — run `bun run build` first.');
    process.exit(1);
}

// ---- Shards ---------------------------------------------------------------

const shardDir = join(DIST, SHARD_BASE_PATH);
const shardFiles = existsSync(shardDir) ? readdirSync(shardDir).filter((f) => f.endsWith('.json')) : [];
check(
    'shard count',
    shardFiles.length === SHARD_COUNT,
    `${shardFiles.length} files, expected ${SHARD_COUNT}`,
);

const shards = new Map<string, ConsumerShard>();
for (const file of shardFiles) {
    try {
        shards.set(file.replace('.json', ''), JSON.parse(readFileSync(join(shardDir, file), 'utf8')));
    } catch (err) {
        fail(`shard ${file} is not valid JSON: ${String(err)}`);
    }
}

let shardedDomains = 0;
for (const kind of Object.keys(DATASET_FILES) as DatasetKind[]) {
    const key = SHARD_KEY[kind];
    const domains = parseDatasetText(readFileSync(join(ROOT, DATASET_FILES[kind]), 'utf8'));
    const misplaced: string[] = [];
    for (const domain of domains) {
        if (!shards.get(shardIdFor(domain))?.[key].includes(domain)) misplaced.push(domain);
    }
    shardedDomains += domains.length;
    check(
        `every ${kind} domain is reachable in its own shard`,
        misplaced.length === 0,
        `${misplaced.length} misplaced, e.g. ${misplaced.slice(0, 3).join(', ')}`,
    );
}

const shardTotal = [...shards.values()].reduce((n, s) => n + s.f.length + s.d.length + s.a.length, 0);
check(
    'shards hold exactly the committed domains',
    shardTotal === shardedDomains,
    `${shardTotal} vs ${shardedDomains}`,
);

// ---- Pages ----------------------------------------------------------------

// The pages that are not generated from PROVIDERS. Kept in one place so a new
// standalone page picks up the JSON-LD and placeholder checks below, and the
// sitemap and llms.txt assertions further down, without being wired in twice.
const STANDALONE_PAGES = [
    '/',
    '/mx-lookup/',
    '/tools/',
    ...TOOLS.map((t) => toolUrl(t.slug)),
    '/guides/',
    ...GUIDES.map((g) => guideUrl(g.slug)),
];

const pages = [
    ...STANDALONE_PAGES.map((p) => join(p.replace(/^\//, ''), 'index.html')),
    ...PROVIDERS.map((p) => join('provider', providerSlug(p), 'index.html')),
];

for (const page of pages) {
    const path = join(DIST, page);
    if (!existsSync(path)) {
        fail(`missing page: ${page}`);
        continue;
    }
    const html = readFileSync(path, 'utf8');

    const stray = html.match(/{{[A-Z_]+}}/g);
    check(`${page} has no unsubstituted placeholders`, !stray, stray?.join(', ') ?? '');

    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!ld) {
        fail(`${page} has no JSON-LD`);
        continue;
    }
    try {
        const parsed = JSON.parse(ld[1]!);
        check(`${page} JSON-LD declares a context`, '@context' in parsed);

        // Every node needs an @id, and every {"@id": …} reference has to point
        // at a node defined on the same page. A reference to a node that only
        // exists elsewhere is a dangling edge: the graph reads as incomplete.
        const graph: Record<string, unknown>[] = parsed['@graph'] ?? [parsed];
        const defined = new Set(graph.map((n) => n['@id']).filter(Boolean) as string[]);

        const untyped = graph.filter((n) => !n['@id']).map((n) => String(n['@type']));
        check(`${page} every JSON-LD node carries an @id`, untyped.length === 0, untyped.join(', '));

        const referenced: string[] = [];
        const collect = (node: unknown): void => {
            if (Array.isArray(node)) {
                for (const v of node) collect(v);
            } else if (node && typeof node === 'object') {
                const obj = node as Record<string, unknown>;
                // A bare {"@id": …} with no other keys is a reference, not a
                // definition.
                if (typeof obj['@id'] === 'string' && Object.keys(obj).length === 1) {
                    referenced.push(obj['@id']);
                }
                for (const v of Object.values(obj)) collect(v);
            }
        };
        collect(graph);

        const dangling = [...new Set(referenced)].filter((id) => !defined.has(id));
        check(
            `${page} JSON-LD references all resolve on the page`,
            dangling.length === 0,
            dangling.join(', '),
        );

        // No review markup. Competitors in this niche ship an aggregateRating
        // with no reviews anywhere on the page, which is a structured data
        // policy violation and a manual-action risk. The site has nothing to
        // aggregate, so the correct count here is zero, permanently.
        const ratings = [
            ...new Set(
                [...JSON.stringify(graph).matchAll(/"@type":"(AggregateRating|Review)"/g)].map((m) => m[1]!),
            ),
        ];
        check(`${page} claims no ratings or reviews`, ratings.length === 0, ratings.join(', '));
    } catch (err) {
        fail(`${page} JSON-LD is invalid: ${String(err)}`);
    }
}

// ---- Tools and internal links ---------------------------------------------

// Each checker page has to carry the form, tagged with the checker main.ts
// should run; a missing or mistyped data-tool silently falls back to the
// provider lookup.
for (const t of TOOLS) {
    const html = readFileSync(join(DIST, toolUrl(t.slug).slice(1), 'index.html'), 'utf8');
    check(`${toolUrl(t.slug)} runs the ${t.key} checker`, html.includes(`data-tool="${t.key}"`));
}
for (const g of GUIDES) {
    const html = readFileSync(join(DIST, guideUrl(g.slug).slice(1), 'index.html'), 'utf8');
    check(`${guideUrl(g.slug)} has no checker form`, !html.includes('id="check-form"'));
}

// Guides and tool pages are hand-written HTML full of cross-links, so a
// renamed slug would leave dead links that nothing else would notice.
const deadLinks = new Set<string>();
for (const page of pages) {
    const path = join(DIST, page);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf8');
    for (const m of html.matchAll(/href="(\/[^"#?]*)/g)) {
        const href = m[1]!;
        if (href.startsWith('//')) continue;
        const target = href.endsWith('/') ? join(DIST, href, 'index.html') : join(DIST, href);
        if (!existsSync(target)) deadLinks.add(`${page} → ${href}`);
    }
}
check('every internal link resolves', deadLinks.size === 0, [...deadLinks].slice(0, 5).join(', '));

// ---- Sitemap, robots, llms ------------------------------------------------

const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
// The standalone pages + one page per provider.
check(
    'sitemap lists every standalone page and every provider',
    locs.length === PROVIDERS.length + STANDALONE_PAGES.length,
    `${locs.length} URLs`,
);
for (const path of STANDALONE_PAGES) {
    check(
        `sitemap lists ${path}`,
        locs.some((l) => new URL(l).pathname === path),
    );
}

for (const loc of locs) {
    const rel = new URL(loc).pathname.replace(/^\//, '');
    const path = join(DIST, rel, rel.endsWith('/') || rel === '' ? 'index.html' : '');
    check(`sitemap URL has a page: ${loc}`, existsSync(path));
}

const lastmods = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]!);
check('every sitemap URL carries a lastmod', lastmods.length === locs.length);
check(
    'lastmod values are ISO dates',
    lastmods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
);

for (const file of ['robots.txt', 'llms.txt', 'main.js', 'styles.css', 'CNAME']) {
    check(`${file} was emitted`, existsSync(join(DIST, file)));
}

// main.js used to be 224 kB, 203 kB of which was the inlined domain lists.
// Guard the regression rather than the exact number. Since the checkers were
// split out, what a provider page loads is main.js plus the chunks it imports
// statically; the checker chunk is only fetched on tool pages.
const mainJs = readFileSync(join(DIST, 'main.js'), 'utf8');
const staticChunks = [...mainJs.matchAll(/from"\.\/(chunks\/[^"]+\.js)"/g)].map((m) => m[1]!);
const lazyChunks = [...mainJs.matchAll(/import\("\.\/(chunks\/[^"]+\.js)"\)/g)].map((m) => m[1]!);
for (const chunk of [...staticChunks, ...lazyChunks])
    check(`${chunk} was emitted`, existsSync(join(DIST, chunk)));
check(
    'the checkers are loaded lazily',
    lazyChunks.some((c) => c.includes('checkers')),
    lazyChunks.join(', '),
);
const eagerBytes = [
    mainJs.length,
    ...staticChunks.map((c) => readFileSync(join(DIST, c), 'utf8').length),
].reduce((a, b) => a + b, 0);
check(
    'the provider lookup bundle does not inline the domain lists or the checkers',
    eagerBytes < 40_000,
    `${(eagerBytes / 1024).toFixed(0)} kB`,
);

const llms = readFileSync(join(DIST, 'llms.txt'), 'utf8');
for (const p of PROVIDERS) {
    check(`llms.txt lists ${p.name}`, llms.includes(`/provider/${providerSlug(p)}/`));
}
// Absolute match, so that the home entry's "/" cannot satisfy the check by
// appearing inside some other provider URL.
const ORIGIN = new URL(locs[0]!).origin;
for (const path of STANDALONE_PAGES) {
    check(`llms.txt lists ${path}`, llms.includes(`${ORIGIN}${path})`));
}

// ---- Result ---------------------------------------------------------------

if (failures.length > 0) {
    console.error(`✗ ${failures.length} of ${checks} checks failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}

console.log(
    `✓ ${checks} build checks passed (${shardedDomains.toLocaleString('en-US')} domains, ${pages.length} pages)`,
);
