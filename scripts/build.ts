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
import { CATEGORY_LABEL, PROVIDERS, providerSlug } from '../src/providers.ts';
import type { Provider } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const PUBL = join(ROOT, 'public');
const HTML = join(ROOT, 'index.html');
const CSS  = join(ROOT, 'src/styles.css');
const NM   = join(ROOT, 'node_modules');

const SITE_ORIGIN = 'https://emailservicechecker.com';
const YEAR = String(new Date().getFullYear());
const TODAY = new Date().toISOString().slice(0, 10);

const FONT_FILES = [
    '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2',
    '@fontsource-variable/onest/files/onest-latin-wght-normal.woff2',
    '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
] as const;

const serve = process.argv.includes('--serve');

if (!existsSync(join(ROOT, 'src/data/consumer-domains.ts'))) {
    console.error('src/data/consumer-domains.ts is missing — run `bun run datasets` first.');
    process.exit(1);
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

// ---- 3. Tailwind ----------------------------------------------------------

console.log('Compiling Tailwind…');
const tw = Bun.spawnSync({
    cmd: ['bun', 'x', 'tailwindcss', '-i', CSS, '-o', join(DIST, 'styles.css'), ...(serve ? [] : ['--minify'])],
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
                    { '@type': 'ListItem', position: 1, name: 'Email Service Checker', item: `${SITE_ORIGIN}/` },
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
    mailbox:   "A mailbox provider runs the inboxes where people read and send mail. Domains that point their MX records here have their email hosted directly by this service.",
    consumer:  "Consumer mailbox services run personal email accounts. A domain whose MX records point here is using the provider's free or low-cost mailbox.",
    gateway:   "A security gateway sits in front of the real mailbox to filter spam, phishing, and malware before mail reaches its destination. Inspection alone cannot tell you which mailbox provider sits behind it.",
    forwarder: "A forwarder accepts mail at one address and re-sends it to another. The final mailbox is invisible from MX records alone — the forwarder is just a relay.",
    relay:     "An inbound relay accepts mail over SMTP and hands it off to an application via API or webhook. There is no human inbox at the other end.",
    parking:   "Domain-parking and aftermarket services publish MX records that point at black-hole servers. Mail sent to a parked domain is almost always silently discarded.",
};

function categoryArticle(c: Provider['category']): string {
    return /^[aeiou]/i.test(CATEGORY_LABEL[c]) ? 'an' : 'a';
}

function describeProvider(p: Provider): string {
    const label = CATEGORY_LABEL[p.category].toLowerCase();
    return `${p.name} is ${categoryArticle(p.category)} ${label}. Its mail servers' hostnames end in ${p.matchers.map(m => `.${m}`).join(', ')}.`;
}

function relatedProviders(p: Provider, limit = 8): Provider[] {
    return PROVIDERS
        .filter(o => o.category === p.category && o.name !== p.name)
        .slice(0, limit);
}

function profileSection(p: Provider): string {
    const slug = providerSlug(p);
    const related = relatedProviders(p);
    const matchersList = p.matchers
        .map(m => `<li class="font-mono text-text">·&nbsp;&nbsp;<code class="break-all">.${escapeHtml(m)}</code></li>`)
        .join('');
    const relatedList = related.length
        ? `<div class="flex flex-col gap-2">
                <p class="eyebrow">Other ${escapeHtml(CATEGORY_LABEL[p.category].toLowerCase())}s</p>
                <ul class="flex flex-wrap gap-2">
                    ${related.map(r => `<li><a class="btn-ghost text-xs" href="/provider/${providerSlug(r)}/">${escapeHtml(r.name)}</a></li>`).join('')}
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

            <p class="text-subtext-1" itemprop="description">${escapeHtml(describeProvider(p))}</p>

            <div class="flex flex-col gap-2">
                <p class="eyebrow">What is ${categoryArticle(p.category)} ${escapeHtml(CATEGORY_LABEL[p.category].toLowerCase())}?</p>
                <p class="text-subtext-1 text-[0.95rem]">${escapeHtml(CATEGORY_DESCRIPTION[p.category])}</p>
            </div>

            <div class="flex flex-col gap-2">
                <p class="eyebrow">MX hostname patterns</p>
                <ul class="flex flex-col gap-1 text-sm">${matchersList}</ul>
            </div>

            ${p.url ? `<p class="text-sm"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Official site →</a></p>` : ''}

            ${relatedList}

            <p class="text-sm text-subtext-0 pt-4 border-t border-crust">
                Want to inspect a different domain? Use the form above, or <a href="/">go back to the homepage</a>.
            </p>
        </section>`;
}

function breadcrumbHtml(items: Array<{ name: string; href?: string }>): string {
    const parts = items.map((it, i) => {
        const isLast = i === items.length - 1;
        const inner = isLast
            ? `<span aria-current="page">${escapeHtml(it.name)}</span>`
            : `<a href="${escapeHtml(it.href ?? '/')}" class="hover:text-text">${escapeHtml(it.name)}</a>`;
        return `<li>${inner}</li>`;
    });
    return `<nav aria-label="Breadcrumb" class="w-full">
        <ol class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-subtext-0 text-xs">
            ${parts.join('<li aria-hidden="true" class="text-surface-1">/</li>')}
        </ol>
    </nav>`;
}

// ---- 5. Emit homepage -----------------------------------------------------

writeFileSync(join(DIST, 'index.html'), render({
    TITLE: 'Email Service Checker — Find Email Providers',
    DESCRIPTION: 'Find out who runs the email for any domain. Detects Google Workspace, Microsoft 365, Proton, Apple, Yahoo, Fastmail, Zoho, and over 160 other providers.',
    CANONICAL: `${SITE_ORIGIN}/`,
    OG_TITLE: 'Email Service Checker — Find Email Providers',
    OG_DESCRIPTION: "Type a domain. We'll tell you which service is running its email.",
    JSON_LD: HOMEPAGE_LD,
    BREADCRUMBS: '',
    HERO_EYEBROW: 'Email provider finder',
    HERO_TITLE: "What's <em>actually</em> handling the mail?",
    HERO_LEDE: "Type a domain or email address. We'll tell you which service is running its email — Google, Microsoft, Proton, Apple, and 160+ others.",
    PROFILE_SECTION: '',
}));

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
    writeFileSync(join(dir, 'index.html'), render({
        TITLE: title,
        DESCRIPTION: `${describeProvider(p)} Check whether any domain uses it.`,
        CANONICAL: `${SITE_ORIGIN}/provider/${slug}/`,
        OG_TITLE: `${p.name} — ${CATEGORY_LABEL[p.category]}`,
        OG_DESCRIPTION: describeProvider(p),
        JSON_LD: providerJsonLd(p),
        BREADCRUMBS: breadcrumbHtml([
            { name: 'Home', href: '/' },
            { name: p.name },
        ]),
        HERO_EYEBROW: escapeHtml(CATEGORY_LABEL[p.category]),
        HERO_TITLE: escapeHtml(p.name),
        HERO_LEDE: `${p.name} is ${categoryArticle(p.category)} ${CATEGORY_LABEL[p.category].toLowerCase()}. Type any domain below to see if its email runs through ${p.name}.`,
        PROFILE_SECTION: profileSection(p),
    }));
}

// ---- 7. Sitemap + robots --------------------------------------------------

const sitemapUrls = [
    { loc: `${SITE_ORIGIN}/`,                 priority: '1.0', change: 'weekly' },
    ...PROVIDERS.map(p => ({
        loc: `${SITE_ORIGIN}/provider/${providerSlug(p)}/`,
        priority: '0.7',
        change: 'monthly',
    })),
];

writeFileSync(
    join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(u => `    <url>
        <loc>${u.loc}</loc>
        <lastmod>${TODAY}</lastmod>
        <changefreq>${u.change}</changefreq>
        <priority>${u.priority}</priority>
    </url>`).join('\n')}
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

// ---- 8. Stats + dev server ------------------------------------------------

const total = readdirSync(DIST, { recursive: true })
    .map(f => {
        try { return statSync(join(DIST, f as string)).size; } catch { return 0; }
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
