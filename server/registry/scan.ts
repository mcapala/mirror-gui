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

/** Minimal ISC shape for catalog-index derivation. */
export interface OperatorCatalogSource {
  mirror?: { operators?: Array<{ catalog?: string }> };
}

/** Support images: operands/related images of catalog bundles, plus the
 * mirrored catalog index repos themselves. Repo-level only (spec §2). */
export function deriveSupportRepos(
  catalogs: CatalogBundles[],
  iscs: OperatorCatalogSource[],
  pathPrefix: string,
): Set<string> {
  const repos = new Set<string>();
  for (const { bundles } of catalogs) {
    for (const detail of Object.values(bundles.packages)) {
      for (const bundle of Object.values(detail.bundles)) {
        for (const ref of bundle.relatedImages ?? []) {
          const parsed = stripImageRef(ref);
          if (parsed) {
            repos.add(joinRepoPath(pathPrefix, parsed.path));
          }
        }
      }
    }
  }
  for (const isc of iscs) {
    for (const entry of isc.mirror?.operators ?? []) {
      const parsed = stripImageRef(entry.catalog ?? '');
      if (parsed) {
        repos.add(joinRepoPath(pathPrefix, parsed.path));
      }
    }
  }
  return repos;
}

/** OpenShift release payload repos, identifiable only by well-known names —
 * there is no local digest data for platform content (spec §2). */
export const PLATFORM_REPOS = [
  'openshift-release-dev/ocp-release',
  'openshift-release-dev/ocp-v4.0-art-dev',
  'openshift/graph-image',
] as const;

/** Minimal ISC shape for platform detection. */
export interface PlatformSource {
  mirror?: { platform?: unknown };
}

export function derivePlatformRepos(
  iscs: PlatformSource[],
  pathPrefix: string,
): Set<string> {
  if (!iscs.some(isc => isc.mirror?.platform)) {
    return new Set();
  }
  return new Set(PLATFORM_REPOS.map(repo => joinRepoPath(pathPrefix, repo)));
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
  supportRepos?: Set<string>,
  platformRepos?: Set<string>,
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
    // Only assign sourceHost/hostAmbiguous for 'additional' origin (not for merged operator repos)
    if (target.origin === 'additional') {
      target.hostAmbiguous = exp.sourceHosts.size > 1;
      target.sourceHost =
        exp.sourceHosts.size === 1 ? [...exp.sourceHosts][0] : null;
    }
  }
  for (const repo of walkedRepos) {
    if (!targets.has(repo)) {
      const origin: RepoOrigin = supportRepos?.has(repo)
        ? 'support'
        : platformRepos?.has(repo)
          ? 'platform'
          : 'walk';
      targets.set(repo, blank(repo, origin));
    }
  }
  return [...targets.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

export interface ScanClientLike {
  listTags(repo: string): Promise<string[] | null>;
  headManifest(repo: string, tag: string): Promise<string | null>;
}

/** Cosign artifact tags (signatures/attestations/SBOMs) shadow a kept image's
 * digest; they are registry plumbing, not mirrored content — skip them. */
const COSIGN_ARTIFACT_TAG = /^sha256-[0-9a-f]{64}\.(sig|att|sbom)$/;

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
  opts: {
    concurrency?: number;
    /** Repos a successful _catalog walk listed. When set, targets outside
     * this set are marked absent without any HTTP probing — the walk shows
     * everything the credentials can see, so "not listed" = "absent". */
    knownRepos?: Set<string>;
  } = {},
): Promise<{ repos: ScannedRepo[]; errors: ScanIssue[]; stats: ScanStats }> {
  const repos: ScannedRepo[] = [];
  const errors: ScanIssue[] = [];
  const ordered = [...targets].sort((a, b) => a.repo.localeCompare(b.repo));

  await forEachWithConcurrency(
    ordered,
    opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY,
    async target => {
      const base = {
        repo: target.repo,
        origin: target.origin,
        sourceHost: target.sourceHost,
        hostAmbiguous: target.hostAmbiguous,
      };
      if (opts.knownRepos && !opts.knownRepos.has(target.repo)) {
        repos.push({ ...base, present: false, tags: [] });
        return;
      }
      let tagNames: string[] | null;
      try {
        tagNames = await client.listTags(target.repo);
      } catch (error) {
        // Registries commonly answer 401/403 for repos that don't exist, to
        // avoid leaking repo existence. The scan route probes /v2/ first, so
        // credentials are known-good here — treat a per-repo auth denial as
        // "repo absent", not as a scan error.
        if (error instanceof RegistryRequestError && error.kind === 'auth') {
          repos.push({ ...base, present: false, tags: [] });
          return;
        }
        errors.push(issueFrom(error, target.repo));
        return;
      }
      if (tagNames === null) {
        repos.push({ ...base, present: false, tags: [] });
        return;
      }
      tagNames = tagNames.filter(tag => !COSIGN_ARTIFACT_TAG.test(tag));
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
      reposSupport: targets.filter(t => t.origin === 'support').length,
      reposPlatform: targets.filter(t => t.origin === 'platform').length,
    },
  };
}

export function buildOperatorContent(
  snapshot: RegistryScanSnapshot,
): OperatorContentReport {
  const packages: Record<string, OperatorContentVersion[]> = {};
  const unknownTags: OperatorContentReport['unknownTags'] = [];
  let tagsScanned = 0;
  let matched = 0;
  for (const repo of snapshot.repos) {
    if (repo.origin !== 'operator') {
      continue;
    }
    for (const tag of repo.tags) {
      tagsScanned += 1;
      if (tag.matched) {
        matched += 1;
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
  const additionalImages: OperatorContentReport['additionalImages'] = [];
  const supportImages: OperatorContentReport['supportImages'] = [];
  const platformImages: OperatorContentReport['platformImages'] = [];
  for (const repo of snapshot.repos) {
    if (repo.origin === 'operator') {
      continue;
    }
    for (const tag of repo.tags) {
      if (repo.origin === 'support') {
        supportImages.push({ repo: repo.repo, tag: tag.tag, digest: tag.digest });
      } else if (repo.origin === 'platform') {
        platformImages.push({ repo: repo.repo, tag: tag.tag, digest: tag.digest });
      } else {
        additionalImages.push({
          repo: repo.repo,
          tag: tag.tag,
          digest: tag.digest,
          source: tag.matchedAdditional,
        });
      }
    }
  }
  const byRepoTag = (
    a: { repo: string; tag: string },
    b: { repo: string; tag: string },
  ) => a.repo.localeCompare(b.repo) || a.tag.localeCompare(b.tag);
  additionalImages.sort(byRepoTag);
  supportImages.sort(byRepoTag);
  platformImages.sort(byRepoTag);
  return {
    registryId: snapshot.registryId,
    host: snapshot.host,
    pathPrefix: snapshot.pathPrefix,
    scannedAt: snapshot.scannedAt,
    partial: snapshot.partial,
    catalogs: snapshot.catalogs,
    packages,
    unknownTags,
    walkOk: snapshot.walkOk,
    additionalImages,
    supportImages,
    platformImages,
    errors: snapshot.errors,
    // Tag-level counts are scoped to operator repos so the badge matches this
    // report's own tables; repo-level counts pass through unchanged — other
    // consumers (e.g. Registry Content's repo summary) see global truth.
    // Support/platform counters come from repos, not stored stats — old
    // snapshots predate the fields.
    stats: {
      ...snapshot.stats,
      tagsScanned,
      matched,
      unknown: tagsScanned - matched,
      reposSupport: snapshot.repos.filter(r => r.origin === 'support').length,
      reposPlatform: snapshot.repos.filter(r => r.origin === 'platform').length,
    },
  };
}
