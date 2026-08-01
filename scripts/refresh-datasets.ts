/**
 * Refreshes the committed consumer-domain lists in ./data/ from upstream.
 *
 *   bun run datasets
 *
 * This is a MAINTENANCE task, not a build step. The build reads the committed
 * files in ./data/ and never touches the network.
 *
 * That split matters: this script used to run during every deploy, so a
 * transient failure at raw.githubusercontent.com — or an upstream rename —
 * broke the deploy of unrelated changes, and there was no committed copy to
 * fall back to. Tracking branch tips also meant upstream edits landed in
 * production with nobody reviewing them. Committing the lists makes builds
 * reproducible and offline, and turns an upstream change into a reviewable
 * diff (see .github/workflows/refresh-datasets.yml, which opens a PR weekly).
 *
 * Sources (both MIT / CC0 / public-domain compatible):
 *   - free:       willwhite/freemail
 *   - disposable: disposable-email-domains/disposable-email-domains
 */

import { DATASET_FILES, DATASET_SOURCES, type DatasetKind, parseDatasetText } from '../src/datasets.ts';

async function fetchList(url: string): Promise<string[]> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
    return parseDatasetText(await res.text());
}

console.log('Refreshing consumer-domain datasets from upstream…');

// Only the kinds that declare an upstream. DATASET_SOURCES is partial because
// data/alias-domains.txt is hand-curated, and this refresh must never rewrite
// it: entries land there by review, not by fetch. Reading the pairs out
// together is what keeps that a type error rather than a silent `undefined`
// URL if a source is ever removed.
const sources = Object.entries(DATASET_SOURCES) as [DatasetKind, string][];
const kinds = sources.map(([kind]) => kind);
const lists = await Promise.all(sources.map(([, url]) => fetchList(url)));

let changed = false;

for (const [i, kind] of kinds.entries()) {
    const domains = lists[i]!;
    if (domains.length === 0) {
        // A source that parses to nothing is far more likely to be a moved URL
        // returning an HTML error page than a genuinely empty blocklist.
        throw new Error(
            `${kind}: upstream returned no usable domains — refusing to overwrite ${DATASET_FILES[kind]}`,
        );
    }

    const path = new URL(`../${DATASET_FILES[kind]}`, import.meta.url);
    const body = `${domains.join('\n')}\n`;
    const before = await Bun.file(path)
        .text()
        .catch(() => '');

    if (before === body) {
        console.log(`  ${kind.padEnd(10)} ${domains.length} domains (unchanged)`);
        continue;
    }

    await Bun.write(path, body);
    changed = true;
    const delta = before ? domains.length - parseDatasetText(before).length : domains.length;
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${kind.padEnd(10)} ${domains.length} domains (${sign}${delta})`);
}

console.log(changed ? 'Datasets updated — commit ./data/.' : 'Datasets already up to date.');
