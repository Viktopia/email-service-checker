/**
 * Builds the static site into ./dist/
 *
 *   bun run build          one-shot production build
 *   bun run dev / --serve  serve dist with live reload via Bun's dev server
 *
 * Emits a homepage and one SEO page per Provider at /provider/<slug>/,
 * plus sitemap.xml and robots.txt — all generated from src/providers.ts.
 */

import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type ConsumerShard, SHARD_BASE_PATH, SHARD_COUNT, shardIdFor } from '../src/consumer-shards.ts';
import { DATASET_FILES, type DatasetKind, parseDatasetText } from '../src/datasets.ts';
import { CATEGORY_LABEL, PROVIDERS, providerSlug } from '../src/providers.ts';
import type { Provider } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const PUBL = join(ROOT, 'public');
const HTML = join(ROOT, 'index.html');
const CSS = join(ROOT, 'src/styles.css');
const NM = join(ROOT, 'node_modules');

const SITE_ORIGIN = 'https://emailservicechecker.com';
const YEAR = String(new Date().getFullYear());
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Last commit date (YYYY-MM-DD) touching any of `paths`, for <lastmod>.
 *
 * Stamping every URL with the build date told Google that all 162 pages
 * changed on every deploy, including when the only change was unrelated — so
 * the signal was worthless. A page's real lastmod is the last time one of its
 * inputs was committed.
 *
 * Falls back to the build date when git history is unavailable (a tarball
 * export, or a shallow clone that does not reach the relevant commit). CI uses
 * fetch-depth: 0 so the real dates are present there.
 */
function gitLastModified(...paths: string[]): string {
    const git = Bun.spawnSync({
        cmd: ['git', 'log', '-1', '--format=%cs', '--', ...paths],
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const date = git.stdout.toString().trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : TODAY;
}

const FONT_FILES = [
    '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2',
    '@fontsource-variable/onest/files/onest-latin-wght-normal.woff2',
    '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
] as const;

const serve = process.argv.includes('--serve');

for (const path of Object.values(DATASET_FILES)) {
    if (!existsSync(join(ROOT, path))) {
        console.error(
            `${path} is missing — it is committed to the repo; run \`bun run datasets\` to regenerate it.`,
        );
        process.exit(1);
    }
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ---- 1. Bundle TypeScript -------------------------------------------------

console.log('Bundling TypeScript…');
const build = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.ts')],
    outdir: DIST,
    minify: !serve,
    sourcemap: serve ? 'inline' : 'none',
    target: 'browser',
    naming: '[name].js',
});
if (!build.success) {
    console.error('Build failed:');
    for (const log of build.logs) console.error(log);
    process.exit(1);
}

// ---- 2. Static assets -----------------------------------------------------

if (existsSync(PUBL)) cpSync(PUBL, DIST, { recursive: true });

mkdirSync(join(DIST, 'fonts'), { recursive: true });
for (const rel of FONT_FILES) {
    const src = join(NM, rel);
    if (!existsSync(src)) {
        console.error(`Missing font file: ${rel} — did you run \`bun install\`?`);
        process.exit(1);
    }
    cpSync(src, join(DIST, 'fonts', rel.split('/').pop()!));
}

// ---- 2b. Consumer-domain shards -------------------------------------------
//
// The lists used to be inlined into main.js — 203 kB of a 224 kB bundle, so
// every visitor downloaded 12,642 domains to test the one they typed. Sharding
// by hash means the runtime fetches only the shard a domain falls into, and it
// stays exact: no bloom-filter false positives telling someone their domain is
// disposable when it is not.

const shards: ConsumerShard[] = Array.from({ length: SHARD_COUNT }, () => ({ f: [], d: [] }));
const datasetCounts: Record<DatasetKind, number> = { free: 0, disposable: 0 };

for (const kind of Object.keys(DATASET_FILES) as DatasetKind[]) {
    const domains = parseDatasetText(readFileSync(join(ROOT, DATASET_FILES[kind]), 'utf8'));
    datasetCounts[kind] = domains.length;
    const key = kind === 'free' ? 'f' : 'd';
    for (const domain of domains) {
        shards[Number.parseInt(shardIdFor(domain), 16)]![key].push(domain);
    }
}

const SHARD_DIR = join(DIST, SHARD_BASE_PATH);
mkdirSync(SHARD_DIR, { recursive: true });
let shardBytes = 0;
for (const [i, shard] of shards.entries()) {
    const body = JSON.stringify(shard);
    shardBytes += body.length;
    writeFileSync(join(SHARD_DIR, `${i.toString(16).padStart(2, '0')}.json`), body);
}
console.log(
    `Sharded ${datasetCounts.free + datasetCounts.disposable} consumer domains ` +
        `(${datasetCounts.free} free, ${datasetCounts.disposable} disposable) into ${SHARD_COUNT} files, ` +
        `${(shardBytes / SHARD_COUNT).toFixed(0)} B average`,
);

// ---- 3. Tailwind ----------------------------------------------------------

console.log('Compiling Tailwind…');
const tw = Bun.spawnSync({
    cmd: [
        'bun',
        'x',
        'tailwindcss',
        '-i',
        CSS,
        '-o',
        join(DIST, 'styles.css'),
        ...(serve ? [] : ['--minify']),
    ],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
});
if (tw.exitCode !== 0) {
    console.error('Tailwind build failed');
    process.exit(1);
}

// ---- 4. Page rendering ----------------------------------------------------

const TEMPLATE = readFileSync(HTML, 'utf8');

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function render(vars: Record<string, string>): string {
    let html = TEMPLATE;
    for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, v);
    html = html.replaceAll('{{YEAR}}', YEAR);
    return html;
}

const PUBLISHER_LD = {
    '@type': 'Organization',
    '@id': `${SITE_ORIGIN}/#publisher`,
    name: 'Email Service Checker',
    url: SITE_ORIGIN,
    logo: {
        '@type': 'ImageObject',
        url: `${SITE_ORIGIN}/logo.webp`,
    },
};

// Shared source of truth for the homepage FAQ — rendered both as visible
// HTML (see homeContentSection) and as FAQPage structured data below, so the
// two can never drift apart.
const FAQ: ReadonlyArray<{ q: string; a: string }> = [
    {
        q: 'How do I find out who my email provider is?',
        a: "Enter your domain or email address — everything after the @ — in the checker at the top of this page. It reads the domain's public MX records over DNS and matches them against 160+ known services, so you instantly see whether Google Workspace, Microsoft 365, Proton, Fastmail, a security gateway, or something else is handling the mail.",
    },
    {
        q: 'How can I check the email service provider for any domain?',
        a: 'Type the domain into the form above and press Check. Every domain that receives email publishes MX (Mail Exchange) records in DNS, and this email provider checker resolves them and names the service behind them. It works for any domain, not just your own — handy for vetting a customer, vendor, or competitor.',
    },
    {
        q: 'Can I find my email provider without logging in anywhere?',
        a: "Yes. The lookup uses only public DNS records, so you never sign in or share a password — you just need the domain name. That is also why it can identify the provider for a domain you don't control.",
    },
    {
        q: 'What is an email service provider?',
        a: 'An email service provider is the company that runs the mail servers for a domain, where messages are received and inboxes live. Common providers are Google Workspace and Microsoft 365 for business, and Gmail, Yahoo, iCloud, and Proton for personal mail. A domain can also route mail through a security gateway or forwarder that sits in front of the real provider.',
    },
    {
        q: 'Why does the checker sometimes show a gateway or forwarder instead of a mailbox?',
        a: 'Some domains point their MX records at a spam-filtering gateway (such as Proofpoint or Mimecast) or at a forwarding service rather than at the final mailbox. In those cases the MX records reveal the relay, and the real mailbox provider can be hidden behind it. The report labels this so you know exactly what you are looking at.',
    },
];

const HOMEPAGE_LD = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
        PUBLISHER_LD,
        {
            '@type': 'WebSite',
            '@id': `${SITE_ORIGIN}/#website`,
            url: SITE_ORIGIN,
            name: 'Email Service Checker',
            publisher: { '@id': `${SITE_ORIGIN}/#publisher` },
            inLanguage: 'en',
            potentialAction: {
                '@type': 'SearchAction',
                target: {
                    '@type': 'EntryPoint',
                    urlTemplate: `${SITE_ORIGIN}/?domain={domain}`,
                },
                'query-input': 'required name=domain',
            },
        },
        {
            '@type': 'FAQPage',
            '@id': `${SITE_ORIGIN}/#faq`,
            inLanguage: 'en',
            isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
            mainEntity: FAQ.map(({ q, a }) => ({
                '@type': 'Question',
                name: q,
                acceptedAnswer: { '@type': 'Answer', text: a },
            })),
        },
    ],
});

function providerJsonLd(p: Provider): string {
    const slug = providerSlug(p);
    const url = `${SITE_ORIGIN}/provider/${slug}/`;
    return JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            PUBLISHER_LD,
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    {
                        '@type': 'ListItem',
                        position: 1,
                        name: 'Email Service Checker',
                        item: `${SITE_ORIGIN}/`,
                    },
                    { '@type': 'ListItem', position: 2, name: p.name, item: url },
                ],
            },
            {
                '@type': 'WebPage',
                '@id': `${url}#webpage`,
                url,
                name: `${p.name} — ${CATEGORY_LABEL[p.category]}`,
                description: describeProvider(p),
                inLanguage: 'en',
                isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
                publisher: { '@id': `${SITE_ORIGIN}/#publisher` },
                about: {
                    '@type': 'Organization',
                    name: p.name,
                    ...(p.url ? { url: p.url, sameAs: p.url } : {}),
                },
            },
        ],
    });
}

const CATEGORY_DESCRIPTION: Record<Provider['category'], string> = {
    mailbox:
        'A mailbox provider runs the inboxes where people read and send mail. Domains that point their MX records here have their email hosted directly by this service.',
    consumer:
        "Consumer mailbox services run personal email accounts. A domain whose MX records point here is using the provider's free or low-cost mailbox.",
    gateway:
        'A security gateway sits in front of the real mailbox to filter spam, phishing, and malware before mail reaches its destination. Inspection alone cannot tell you which mailbox provider sits behind it.',
    forwarder:
        'A forwarder accepts mail at one address and re-sends it to another. The final mailbox is invisible from MX records alone — the forwarder is just a relay.',
    relay: 'An inbound relay accepts mail over SMTP and hands it off to an application via API or webhook. There is no human inbox at the other end.',
    parking:
        'Domain-parking and aftermarket services publish MX records that point at black-hole servers. Mail sent to a parked domain is almost always silently discarded.',
};

function categoryArticle(c: Provider['category']): string {
    return /^[aeiou]/i.test(CATEGORY_LABEL[c]) ? 'an' : 'a';
}

function describeProvider(p: Provider): string {
    const label = CATEGORY_LABEL[p.category].toLowerCase();
    return `${p.name} is ${categoryArticle(p.category)} ${label}. Its mail servers' hostnames end in ${p.matchers.map((m) => `.${m}`).join(', ')}.`;
}

function relatedProviders(p: Provider, limit = 8): Provider[] {
    return PROVIDERS.filter((o) => o.category === p.category && o.name !== p.name).slice(0, limit);
}

function profileSection(p: Provider): string {
    const slug = providerSlug(p);
    const related = relatedProviders(p);
    const matchersList = p.matchers
        .map(
            (m) =>
                `<li class="font-mono text-ink">·&nbsp;&nbsp;<code class="break-all">.${escapeHtml(m)}</code></li>`,
        )
        .join('');
    const relatedList = related.length
        ? `<div class="flex flex-col gap-2">
                <p class="eyebrow">Other ${escapeHtml(CATEGORY_LABEL[p.category].toLowerCase())}s</p>
                <ul class="flex flex-wrap gap-2">
                    ${related.map((r) => `<li><a class="btn-ghost text-xs" href="/provider/${providerSlug(r)}/">${escapeHtml(r.name)}</a></li>`).join('')}
                </ul>
            </div>`
        : '';
    return `
        <section class="card p-6 sm:p-8 flex flex-col gap-6" data-provider="${escapeHtml(slug)}" itemscope itemtype="https://schema.org/Organization">
            ${p.url ? `<link itemprop="sameAs" href="${escapeHtml(p.url)}">` : ''}
            <div class="flex items-start justify-between gap-3">
                <div class="flex flex-col gap-1 min-w-0">
                    <p class="eyebrow">Provider profile</p>
                    <h2 class="display-name break-words" itemprop="name">${escapeHtml(p.name)}</h2>
                </div>
                <span class="cat-badge cat-${p.category}">${escapeHtml(CATEGORY_LABEL[p.category])}</span>
            </div>

            <p class="text-ink-muted" itemprop="description">${escapeHtml(describeProvider(p))}</p>

            <div class="flex flex-col gap-2">
                <p class="eyebrow">What is ${categoryArticle(p.category)} ${escapeHtml(CATEGORY_LABEL[p.category].toLowerCase())}?</p>
                <p class="text-ink-muted text-[0.95rem]">${escapeHtml(CATEGORY_DESCRIPTION[p.category])}</p>
            </div>

            <div class="flex flex-col gap-2">
                <p class="eyebrow">MX hostname patterns</p>
                <ul class="flex flex-col gap-1 text-sm">${matchersList}</ul>
            </div>

            ${p.url ? `<p class="text-sm"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Official site →</a></p>` : ''}

            ${relatedList}

            <p class="text-sm text-ink-muted pt-4 border-t border-crust">
                Want to inspect a different domain? Use the form above, or <a href="/">go back to the homepage</a>.
            </p>
        </section>`;
}

function breadcrumbHtml(items: Array<{ name: string; href?: string }>): string {
    const parts = items.map((it, i) => {
        const isLast = i === items.length - 1;
        const inner = isLast
            ? `<span aria-current="page">${escapeHtml(it.name)}</span>`
            : `<a href="${escapeHtml(it.href ?? '/')}" class="hover:text-ink">${escapeHtml(it.name)}</a>`;
        return `<li>${inner}</li>`;
    });
    return `<nav aria-label="Breadcrumb" class="w-full">
        <ol class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-ink-muted text-xs">
            ${parts.join('<li aria-hidden="true" class="text-ink-muted">/</li>')}
        </ol>
    </nav>`;
}

// Homepage-only content: a short how-to guide plus an FAQ. Targets the
// informational "how to find out who my email provider is" queries and backs
// the FAQPage structured data in HOMEPAGE_LD. Rendered only on the homepage so
// it is not duplicated across the per-provider pages.
function homeContentSection(): string {
    const faqHtml = FAQ.map(
        ({ q, a }) => `
                <div class="flex flex-col gap-1.5">
                    <h3 class="text-ink font-semibold text-[1.05rem]">${escapeHtml(q)}</h3>
                    <p class="text-ink-muted text-[0.95rem]">${escapeHtml(a)}</p>
                </div>`,
    ).join('');

    return `
        <section class="card p-6 sm:p-8 flex flex-col gap-5">
            <div class="flex flex-col gap-1">
                <p class="eyebrow">Guide</p>
                <h2 class="display-name">How to find out who your email provider is</h2>
            </div>
            <p class="text-ink-muted">Every domain that can receive email advertises its mail servers in public DNS through <strong>MX (Mail Exchange) records</strong>. Reading those records tells you which email service provider a domain uses — no login or password required. Here is how to check it:</p>
            <ol class="flex flex-col gap-3 text-ink-muted text-[0.95rem] list-decimal pl-5 marker:text-ink-muted">
                <li>Take the domain you want to look up — for an email address, that is everything after the <code>@</code>.</li>
                <li>Enter it in the checker at the top of this page and press Check.</li>
                <li>The tool resolves the domain's MX records over DNS and matches them against 160+ known providers.</li>
                <li>You get the provider name, its category — mailbox, gateway, forwarder, or relay — and the raw MX records as evidence.</li>
            </ol>
        </section>

        <section class="card p-6 sm:p-8 flex flex-col gap-6" aria-labelledby="faq-heading">
            <div class="flex flex-col gap-1">
                <p class="eyebrow">FAQ</p>
                <h2 id="faq-heading" class="display-name">Checking email providers — common questions</h2>
            </div>${faqHtml}
        </section>`;
}

// ---- 5. Emit homepage -----------------------------------------------------

writeFileSync(
    join(DIST, 'index.html'),
    render({
        TITLE: "Email Service Checker — Check Any Domain's Email Provider",
        DESCRIPTION:
            "Check any domain's email provider in seconds. Find out who runs the email — Google Workspace, Microsoft 365, Proton, Apple, Yahoo, Fastmail, Zoho, and 160+ others — straight from public MX records.",
        CANONICAL: `${SITE_ORIGIN}/`,
        OG_TITLE: "Email Service Checker — Check Any Domain's Email Provider",
        OG_DESCRIPTION: "Type a domain or email address and we'll check which service is running its email.",
        JSON_LD: HOMEPAGE_LD,
        BREADCRUMBS: '',
        HERO_EYEBROW: 'Email provider checker',
        HERO_TITLE: "What's <em>actually</em> handling the mail?",
        HERO_LEDE:
            "Type a domain or email address to find out who your email provider is. We'll check which service runs its mail — Google, Microsoft, Proton, Apple, and 160+ others.",
        PROFILE_SECTION: '',
        CONTENT_SECTION: homeContentSection(),
    }),
);

// ---- 6. Emit per-provider pages ------------------------------------------

const seen = new Set<string>();
for (const p of PROVIDERS) {
    const slug = providerSlug(p);
    if (seen.has(slug)) {
        console.error(`Slug collision: ${slug} (provider "${p.name}")`);
        process.exit(1);
    }
    seen.add(slug);

    const dir = join(DIST, 'provider', slug);
    mkdirSync(dir, { recursive: true });
    const title = `${p.name} — ${CATEGORY_LABEL[p.category]} | Email Service Checker`;
    writeFileSync(
        join(dir, 'index.html'),
        render({
            TITLE: title,
            DESCRIPTION: `${describeProvider(p)} Check whether any domain uses it.`,
            CANONICAL: `${SITE_ORIGIN}/provider/${slug}/`,
            OG_TITLE: `${p.name} — ${CATEGORY_LABEL[p.category]}`,
            OG_DESCRIPTION: describeProvider(p),
            JSON_LD: providerJsonLd(p),
            BREADCRUMBS: breadcrumbHtml([{ name: 'Home', href: '/' }, { name: p.name }]),
            HERO_EYEBROW: escapeHtml(CATEGORY_LABEL[p.category]),
            HERO_TITLE: escapeHtml(p.name),
            HERO_LEDE: `${p.name} is ${categoryArticle(p.category)} ${CATEGORY_LABEL[p.category].toLowerCase()}. Type any domain below to see if its email runs through ${p.name}.`,
            PROFILE_SECTION: profileSection(p),
            CONTENT_SECTION: '',
        }),
    );
}

// ---- 7. Sitemap + robots --------------------------------------------------

// Provider pages are generated wholesale from src/providers.ts and the shared
// template, so their content changes when one of those is committed. The
// homepage additionally carries the FAQ, which lives in this script.
const PROVIDERS_MODIFIED = gitLastModified('src/providers.ts', 'index.html', 'src/styles.css');
const HOMEPAGE_MODIFIED = gitLastModified(
    'src/providers.ts',
    'index.html',
    'src/styles.css',
    'scripts/build.ts',
);

const sitemapUrls = [
    { loc: `${SITE_ORIGIN}/`, priority: '1.0', change: 'weekly', lastmod: HOMEPAGE_MODIFIED },
    ...PROVIDERS.map((p) => ({
        loc: `${SITE_ORIGIN}/provider/${providerSlug(p)}/`,
        priority: '0.7',
        change: 'monthly',
        lastmod: PROVIDERS_MODIFIED,
    })),
];

writeFileSync(
    join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls
    .map(
        (u) => `    <url>
        <loc>${u.loc}</loc>
        <lastmod>${u.lastmod}</lastmod>
        <changefreq>${u.change}</changefreq>
        <priority>${u.priority}</priority>
    </url>`,
    )
    .join('\n')}
</urlset>
`,
);

writeFileSync(
    join(DIST, 'robots.txt'),
    `User-agent: *
Allow: /

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`,
);

// llms.txt — https://llmstxt.org/. Generated from the same PROVIDERS array as
// the pages and the sitemap, so it cannot claim a provider the site does not
// actually have a page for.
const providersByCategory = new Map<Provider['category'], Provider[]>();
for (const p of PROVIDERS) {
    const list = providersByCategory.get(p.category) ?? [];
    list.push(p);
    providersByCategory.set(p.category, list);
}

writeFileSync(
    join(DIST, 'llms.txt'),
    `# Email Service Checker

> Identifies which email provider, security gateway, or forwarder handles a
> domain's mail by reading its public MX records. No sign-in, no data stored —
> the lookup runs in the browser against public DNS.

Enter any domain or email address and the checker resolves its MX records and
matches them against ${PROVIDERS.length} known services. It also flags domains that appear in the
open free-mailbox (${datasetCounts.free.toLocaleString('en-US')} domains) and disposable-mailbox
(${datasetCounts.disposable.toLocaleString('en-US')} domains) datasets.

## Pages

- [Home — check any domain](${SITE_ORIGIN}/): the checker itself, plus answers to common questions about finding a domain's email provider.
${[...providersByCategory.entries()]
    .map(
        ([category, list]) => `
## ${CATEGORY_LABEL[category]} (${list.length})

${CATEGORY_DESCRIPTION[category]}

${list.map((p) => `- [${p.name}](${SITE_ORIGIN}/provider/${providerSlug(p)}/): how to tell whether a domain's mail runs through ${p.name}, and the MX hostnames that identify it.`).join('\n')}`,
    )
    .join('\n')}
`,
);

// ---- 8. Stats + dev server ------------------------------------------------

const total = readdirSync(DIST, { recursive: true })
    .map((f) => {
        try {
            return statSync(join(DIST, f as string)).size;
        } catch {
            return 0;
        }
    })
    .reduce((a, b) => a + b, 0);

console.log(`Built ${(total / 1024).toFixed(1)} kB — ${PROVIDERS.length} provider pages + sitemap → ${DIST}`);

if (serve) {
    const port = Number(process.env.PORT ?? 3000);
    Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);
            let path = url.pathname;
            if (path.endsWith('/')) path += 'index.html';
            const file = Bun.file(join(DIST, path));
            if (await file.exists()) return new Response(file);
            // Fallback: serve homepage with 404 status for unknown paths
            return new Response(Bun.file(join(DIST, 'index.html')), { status: 404 });
        },
    });
    console.log(`Serving at http://localhost:${port}`);
}
