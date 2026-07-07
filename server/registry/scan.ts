import {
  RegistryRequestError,
  type CatalogBundles,
  type ExpectedBundleRef,
  type OperatorContentReport,
  type OperatorContentVersion,
  type RegistryScanSnapshot,
  type RepoExpectation,
  type ScanIssue,
  type ScannedRepo,
  type ScannedTag,
  type ScanStats,
} from './types.js';

export const DEFAULT_SCAN_CONCURRENCY = 8;

export interface ParsedImageRef {
  path: string;
  digest: string | null;
  tag: string | null;
}

export function stripImageRef(ref: string): ParsedImageRef | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  let rest = ref.slice(slash + 1);
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > rest.lastIndexOf('/')) {
    tag = rest.slice(lastColon + 1) || null;
    rest = rest.slice(0, lastColon);
  }
  if (!rest) {
    return null;
  }
  // A digest-pinned ref may also carry a tag; the digest governs (spec §3.2).
  return { path: rest, digest, tag: digest ? null : tag };
}

export function joinRepoPath(pathPrefix: string, imagePath: string): string {
  return pathPrefix ? `${pathPrefix}/${imagePath}` : imagePath;
}

export function deriveExpectations(
  catalogs: CatalogBundles[],
  pathPrefix: string,
): Map<string, RepoExpectation> {
  const expectations = new Map<string, RepoExpectation>();
  for (const { catalog, bundles } of catalogs) {
    for (const [pkg, detail] of Object.entries(bundles.packages)) {
      for (const [bundleName, bundle] of Object.entries(detail.bundles)) {
        const parsed = stripImageRef(bundle.image);
        if (!parsed) {
          continue;
        }
        const repo = joinRepoPath(pathPrefix, parsed.path);
        let expectation = expectations.get(repo);
        if (!expectation) {
          expectation = { repo, byDigest: new Map(), byTag: new Map() };
          expectations.set(repo, expectation);
        }
        const ref: ExpectedBundleRef = {
          package: pkg,
          bundleName,
          version: bundle.version,
          catalog,
        };
        if (parsed.digest) {
          if (!expectation.byDigest.has(parsed.digest)) {
            expectation.byDigest.set(parsed.digest, ref);
          }
        } else if (parsed.tag) {
          if (!expectation.byTag.has(parsed.tag)) {
            expectation.byTag.set(parsed.tag, ref);
          }
        }
      }
    }
  }
  return expectations;
}

export interface ScanClientLike {
  listTags(repo: string): Promise<string[] | null>;
  headManifest(repo: string, tag: string): Promise<string | null>;
}

function issueFrom(error: unknown, repo: string): ScanIssue {
  if (error instanceof RegistryRequestError) {
    return { repo, catalog: null, kind: error.kind, message: error.message };
  }
  return {
    repo,
    catalog: null,
    kind: 'unreachable',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

export async function executeScan(
  expectations: Map<string, RepoExpectation>,
  client: ScanClientLike,
  opts: { concurrency?: number } = {},
): Promise<{ repos: ScannedRepo[]; errors: ScanIssue[]; stats: ScanStats }> {
  const repos: ScannedRepo[] = [];
  const errors: ScanIssue[] = [];
  const ordered = [...expectations.values()].sort((a, b) =>
    a.repo.localeCompare(b.repo),
  );

  await forEachWithConcurrency(
    ordered,
    opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY,
    async expectation => {
      let tagNames: string[] | null;
      try {
        tagNames = await client.listTags(expectation.repo);
      } catch (error) {
        errors.push(issueFrom(error, expectation.repo));
        return;
      }
      if (tagNames === null) {
        repos.push({ repo: expectation.repo, present: false, tags: [] });
        return;
      }
      const tags: ScannedTag[] = [];
      for (const tag of tagNames) {
        let digest: string | null = null;
        try {
          digest = await client.headManifest(expectation.repo, tag);
        } catch (error) {
          errors.push(issueFrom(error, expectation.repo));
        }
        const matched =
          (digest ? expectation.byDigest.get(digest) : undefined) ??
          expectation.byTag.get(tag) ??
          null;
        tags.push({ tag, digest, matched });
      }
      repos.push({ repo: expectation.repo, present: true, tags });
    },
  );

  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  const allTags = repos.flatMap(r => r.tags);
  const matched = allTags.filter(t => t.matched).length;
  return {
    repos,
    errors,
    stats: {
      reposExpected: expectations.size,
      reposPresent: repos.filter(r => r.present).length,
      tagsScanned: allTags.length,
      matched,
      unknown: allTags.length - matched,
    },
  };
}

export function buildOperatorContent(
  snapshot: RegistryScanSnapshot,
): OperatorContentReport {
  const packages: Record<string, OperatorContentVersion[]> = {};
  const unknownTags: OperatorContentReport['unknownTags'] = [];
  for (const repo of snapshot.repos) {
    for (const tag of repo.tags) {
      if (tag.matched) {
        (packages[tag.matched.package] ??= []).push({
          version: tag.matched.version,
          bundleName: tag.matched.bundleName,
          repo: repo.repo,
          tag: tag.tag,
          digest: tag.digest,
          catalog: tag.matched.catalog,
        });
      } else {
        unknownTags.push({ repo: repo.repo, tag: tag.tag, digest: tag.digest });
      }
    }
  }
  for (const versions of Object.values(packages)) {
    versions.sort((a, b) =>
      (a.version ?? '').localeCompare(b.version ?? '', undefined, {
        numeric: true,
      }),
    );
  }
  return {
    registryId: snapshot.registryId,
    host: snapshot.host,
    pathPrefix: snapshot.pathPrefix,
    scannedAt: snapshot.scannedAt,
    partial: snapshot.partial,
    catalogs: snapshot.catalogs,
    packages,
    unknownTags,
    errors: snapshot.errors,
    stats: snapshot.stats,
  };
}
