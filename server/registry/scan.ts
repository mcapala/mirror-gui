import {
  RegistryRequestError,
  type AdditionalRepoExpectation,
  type CatalogBundles,
  type ExpectedBundleRef,
  type OperatorContentReport,
  type OperatorContentVersion,
  type RegistryScanSnapshot,
  type RepoExpectation,
  type RepoOrigin,
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

/** Minimal ISC shape this module needs; the full IscConfig satisfies it. */
export interface AdditionalImagesSource {
  mirror?: { additionalImages?: Array<{ name: string }> };
}

export function deriveAdditionalExpectations(
  iscs: AdditionalImagesSource[],
  pathPrefix: string,
): Map<string, AdditionalRepoExpectation> {
  const expectations = new Map<string, AdditionalRepoExpectation>();
  for (const isc of iscs) {
    for (const entry of isc.mirror?.additionalImages ?? []) {
      const ref = typeof entry?.name === 'string' ? entry.name : '';
      const parsed = stripImageRef(ref);
      if (!parsed) {
        continue;
      }
      const host = ref.slice(0, ref.indexOf('/'));
      const repo = joinRepoPath(pathPrefix, parsed.path);
      let expectation = expectations.get(repo);
      if (!expectation) {
        expectation = {
          repo,
          sourceHosts: new Set(),
          byDigest: new Map(),
          byTag: new Map(),
        };
        expectations.set(repo, expectation);
      }
      expectation.sourceHosts.add(host);
      if (parsed.digest) {
        if (!expectation.byDigest.has(parsed.digest)) {
          expectation.byDigest.set(parsed.digest, ref);
        }
      } else {
        // A ref with neither digest nor tag means :latest.
        const tag = parsed.tag ?? 'latest';
        if (!expectation.byTag.has(tag)) {
          expectation.byTag.set(tag, ref);
        }
      }
    }
  }
  return expectations;
}

export interface ScanTarget {
  repo: string;
  origin: RepoOrigin;
  sourceHost: string | null;
  hostAmbiguous: boolean;
  bundleByDigest: Map<string, ExpectedBundleRef>;
  bundleByTag: Map<string, ExpectedBundleRef>;
  additionalByDigest: Map<string, string>;
  additionalByTag: Map<string, string>;
}

export function buildScanTargets(
  operator: Map<string, RepoExpectation>,
  additional: Map<string, AdditionalRepoExpectation>,
  walkedRepos: string[],
): ScanTarget[] {
  const targets = new Map<string, ScanTarget>();
  const blank = (repo: string, origin: RepoOrigin): ScanTarget => ({
    repo,
    origin,
    sourceHost: null,
    hostAmbiguous: false,
    bundleByDigest: new Map(),
    bundleByTag: new Map(),
    additionalByDigest: new Map(),
    additionalByTag: new Map(),
  });
  for (const exp of operator.values()) {
    const target = blank(exp.repo, 'operator');
    target.bundleByDigest = exp.byDigest;
    target.bundleByTag = exp.byTag;
    targets.set(exp.repo, target);
  }
  for (const exp of additional.values()) {
    let target = targets.get(exp.repo);
    if (!target) {
      target = blank(exp.repo, 'additional');
      targets.set(exp.repo, target);
    }
    target.additionalByDigest = exp.byDigest;
    target.additionalByTag = exp.byTag;
    target.hostAmbiguous = exp.sourceHosts.size > 1;
    target.sourceHost =
      exp.sourceHosts.size === 1 ? [...exp.sourceHosts][0] : null;
  }
  for (const repo of walkedRepos) {
    if (!targets.has(repo)) {
      targets.set(repo, blank(repo, 'walk'));
    }
  }
  return [...targets.values()].sort((a, b) => a.repo.localeCompare(b.repo));
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
  targets: ScanTarget[],
  client: ScanClientLike,
  opts: { concurrency?: number } = {},
): Promise<{ repos: ScannedRepo[]; errors: ScanIssue[]; stats: ScanStats }> {
  const repos: ScannedRepo[] = [];
  const errors: ScanIssue[] = [];
  const ordered = [...targets].sort((a, b) => a.repo.localeCompare(b.repo));

  await forEachWithConcurrency(
    ordered,
    opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY,
    async target => {
      let tagNames: string[] | null;
      try {
        tagNames = await client.listTags(target.repo);
      } catch (error) {
        errors.push(issueFrom(error, target.repo));
        return;
      }
      const base = {
        repo: target.repo,
        origin: target.origin,
        sourceHost: target.sourceHost,
        hostAmbiguous: target.hostAmbiguous,
      };
      if (tagNames === null) {
        repos.push({ ...base, present: false, tags: [] });
        return;
      }
      const tags: ScannedTag[] = [];
      const headIssues: ScanIssue[] = [];
      for (const tag of tagNames) {
        let digest: string | null = null;
        try {
          digest = await client.headManifest(target.repo, tag);
        } catch (error) {
          headIssues.push(issueFrom(error, target.repo));
        }
        const matched =
          (digest ? target.bundleByDigest.get(digest) : undefined) ??
          target.bundleByTag.get(tag) ??
          null;
        const matchedAdditional =
          (digest ? target.additionalByDigest.get(digest) : undefined) ??
          target.additionalByTag.get(tag) ??
          null;
        tags.push({ tag, digest, matched, matchedAdditional });
      }
      if (headIssues.length === 1) {
        errors.push(headIssues[0]);
      } else if (headIssues.length > 1) {
        errors.push({
          ...headIssues[0],
          message: `${headIssues[0].message} (${headIssues.length} tags affected)`,
        });
      }
      repos.push({ ...base, present: true, tags });
    },
  );

  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  const allTags = repos.flatMap(r => r.tags);
  const matched = allTags.filter(t => t.matched || t.matchedAdditional).length;
  const operatorRepos = repos.filter(r => r.origin === 'operator');
  return {
    repos,
    errors,
    stats: {
      reposExpected: targets.filter(t => t.origin === 'operator').length,
      reposPresent: operatorRepos.filter(r => r.present).length,
      tagsScanned: allTags.length,
      matched,
      unknown: allTags.length - matched,
      reposAdditional: targets.filter(t => t.origin === 'additional').length,
      reposWalked: targets.filter(t => t.origin === 'walk').length,
    },
  };
}

export function buildOperatorContent(
  snapshot: RegistryScanSnapshot,
): OperatorContentReport {
  const packages: Record<string, OperatorContentVersion[]> = {};
  const unknownTags: OperatorContentReport['unknownTags'] = [];
  for (const repo of snapshot.repos) {
    if (repo.origin !== 'operator') {
      continue;
    }
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
