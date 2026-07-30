/**
 * Where the consumer-domain datasets come from, where they live, and how a
 * raw list is normalised.
 *
 * Shared by scripts/refresh-datasets.ts (which writes ./data/) and
 * scripts/build.ts (which reads it) so the two cannot disagree about the
 * filenames or about what counts as a valid domain line.
 */

export type DatasetKind = 'free' | 'disposable';

export const DATASET_SOURCES: Readonly<Record<DatasetKind, string>> = {
    free: 'https://raw.githubusercontent.com/willwhite/freemail/master/data/free.txt',
    disposable:
        'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
};

/** Repo-relative paths of the committed lists. */
export const DATASET_FILES: Readonly<Record<DatasetKind, string>> = {
    free: 'data/free-domains.txt',
    disposable: 'data/disposable-domains.txt',
};

/** Only plain ASCII domains — punycode is already ASCII, so IDNs survive. */
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * Normalises a raw list into sorted, deduplicated, validated domains.
 *
 * Sorting and deduplicating here (rather than at render time) is what keeps
 * the committed files diffable: an upstream addition shows up as one added
 * line instead of reshuffling the file.
 */
export function parseDatasetText(text: string): string[] {
    const domains = text
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line && !line.startsWith('#'))
        .filter((line) => DOMAIN_RE.test(line));
    return [...new Set(domains)].sort();
}
