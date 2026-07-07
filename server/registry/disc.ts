import YAML from 'yaml';
import { catalogKeyFromUrl, type IscConfig } from '../acm/reconcile.js';
import type { DeployedOperatorSnapshot } from '../acm/types.js';
import type { BundleDetail, ChannelEntryDetail } from '../bundlesLoader.js';
import { compareVersionStrings } from '../utils.js';
import { stripImageRef } from './scan.js';
import type { CatalogBundles, RegistryScanSnapshot } from './types.js';

/** Host guess for orphan-repo source refs; the user edits it in the UI.
 * A wrong host is a delete-time no-op, never a wrong deletion (spec §13). */
export const DEFAULT_ORPHAN_HOST = 'registry.redhat.io';

export interface DiscInputs {
  snapshot: RegistryScanSnapshot;
  catalogs: CatalogBundles[];
  acm: DeployedOperatorSnapshot | null;
  iscs: IscConfig[];
}

export interface OrphanPick {
  repo: string;
  tag: string;
  sourceRef: string;
}

export interface DiscOptions {
  strict: boolean;
  includeAdditionalImages: boolean;
  includeOrphans: OrphanPick[];
}

export interface OperatorCandidate {
  catalog: string;
  catalogRef: string;
  package: string;
  channel: string;
  version: string;
  bundleName: string;
  repo: string;
  tag: string;
  digest: string | null;
}

export interface HeldCandidate {
  kind: 'operator' | 'additional-image';
  reason: 'still-deployed' | 'shared-image' | 'acm-unverifiable';
  detail: string;
  package?: string;
  version?: string;
  bundleName?: string;
  repo?: string;
  tag?: string;
}

export interface AdditionalCandidate {
  repo: string;
  tag: string;
  digest: string | null;
  sourceRef: string;
}

export interface OrphanItem {
  repo: string;
  tag: string;
  digest: string | null;
  suggestedRef: string;
  hostAmbiguous: boolean;
}

export interface DiscReport {
  registryId: string;
  host: string;
  pathPrefix: string;
  scannedAt: string;
  acmRefreshedAt: string | null;
  walkOk: boolean;
  warnings: string[];
  operators: {
    candidates: OperatorCandidate[];
    held: HeldCandidate[];
    unknownTags: Array<{ repo: string; tag: string; digest: string | null }>;
    unverifiableRepos: Array<{ repo: string; message: string }>;
    channelUnpinned: Array<{ catalog: string; package: string }>;
    unknownChannels: Array<{ catalog: string; package: string; channel: string }>;
    manualBundles: Array<{
      catalog: string;
      package: string;
      bundleName: string;
      version: string | null;
      repo: string;
      tag: string;
      reason: string;
    }>;
  };
  additionalImages: {
    class1: AdditionalCandidate[];
    held: HeldCandidate[];
    orphans: OrphanItem[];
    rejectedPicks: Array<{ repo: string; tag: string; reason: string }>;
  };
  stats: { discOperatorEntries: number; discAdditionalImages: number };
}

export interface DiscResult {
  discYaml: string;
  report: DiscReport;
  strictViolation: boolean;
}

const norm = (v: string): string => v.replace(/^v/, '');
const cmp = (a: string, b: string): number =>
  compareVersionStrings(norm(a), norm(b));

/** Registry repo path minus the configured pathPrefix. */
export function repoSuffix(repo: string, pathPrefix: string): string {
  return pathPrefix && repo.startsWith(`${pathPrefix}/`)
    ? repo.slice(pathPrefix.length + 1)
    : repo;
}

/** Channel head: the entry no other entry replaces or skips. Ties: highest
 * parsable version, then lexicographic. Null when unresolvable (cycle). */
export function resolveChannelHead(
  entries: ChannelEntryDetail[],
  bundles: Record<string, BundleDetail>,
): string | null {
  const referenced = new Set<string>();
  for (const entry of entries) {
    if (entry.replaces) {
      referenced.add(entry.replaces);
    }
    for (const skip of entry.skips ?? []) {
      referenced.add(skip);
    }
  }
  const heads = entries.filter(e => !referenced.has(e.name));
  if (heads.length === 0) {
    return null;
  }
  heads.sort((a, b) => {
    const va = bundles[a.name]?.version;
    const vb = bundles[b.name]?.version;
    if (va && vb && cmp(va, vb) !== 0) {
      return cmp(vb, va);
    }
    if (va && !vb) {
      return -1;
    }
    if (!va && vb) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return heads[0].name;
}

const pkgKey = (catalog: string, pkg: string): string => `${catalog} ${pkg}`;

interface KeepSets {
  keptBundles: Map<string, Set<string>>;
  fullyKept: Set<string>;
  /** digest → human-readable owner; path:tag → owner. */
  keptDigests: Map<string, string>;
  keptPathTags: Map<string, string>;
  catalogRefs: Map<string, string>;
  channelUnpinned: Array<{ catalog: string; package: string }>;
  unknownChannels: Array<{ catalog: string; package: string; channel: string }>;
  warnings: string[];
}

function buildKeepSets(iscs: IscConfig[], catalogs: CatalogBundles[]): KeepSets {
  const sets: KeepSets = {
    keptBundles: new Map(),
    fullyKept: new Set(),
    keptDigests: new Map(),
    keptPathTags: new Map(),
    catalogRefs: new Map(),
    channelUnpinned: [],
    unknownChannels: [],
    warnings: [],
  };
  const bundlesByKey = new Map(catalogs.map(c => [c.catalog, c.bundles]));
  const missingWarned = new Set<string>();
  const keep = (key: string, bundleName: string): void => {
    let set = sets.keptBundles.get(key);
    if (!set) {
      set = new Set();
      sets.keptBundles.set(key, set);
    }
    set.add(bundleName);
  };

  for (const isc of iscs) {
    for (const entry of isc.mirror?.operators ?? []) {
      const key = catalogKeyFromUrl(entry.catalog ?? '');
      if (!key) {
        continue;
      }
      const existingRef = sets.catalogRefs.get(key);
      if (!existingRef || entry.catalog.localeCompare(existingRef) < 0) {
        sets.catalogRefs.set(key, entry.catalog);
      }
      // oc-mirror mirrors the catalog index itself; it must never be
      // deletable (spec §7.2/§9) — join it into the kept-images indexes so
      // the shared-image guard holds/rejects any candidate or orphan pick
      // that collides with it.
      const parsedCatalog = stripImageRef(entry.catalog ?? '');
      if (parsedCatalog) {
        const owner = `catalog ${entry.catalog}`;
        if (parsedCatalog.digest) {
          if (!sets.keptDigests.has(parsedCatalog.digest)) {
            sets.keptDigests.set(parsedCatalog.digest, owner);
          }
        } else {
          const pathTag = `${parsedCatalog.path}:${parsedCatalog.tag ?? 'latest'}`;
          if (!sets.keptPathTags.has(pathTag)) {
            sets.keptPathTags.set(pathTag, owner);
          }
        }
      }
      const bundles = bundlesByKey.get(key);
      if (!bundles) {
        if (!missingWarned.has(key)) {
          missingWarned.add(key);
          sets.warnings.push(
            `bundles.json unavailable for catalog ${key} — its packages are suppressed (nothing kept, nothing deleted)`,
          );
        }
        continue;
      }
      if (entry.full) {
        for (const [pkg, detail] of Object.entries(bundles.packages)) {
          const k = pkgKey(key, pkg);
          sets.fullyKept.add(k);
          for (const name of Object.keys(detail.bundles)) {
            keep(k, name);
          }
        }
        continue;
      }
      for (const pkg of entry.packages ?? []) {
        const detail = bundles.packages[pkg.name];
        const k = pkgKey(key, pkg.name);
        if (!detail) {
          sets.warnings.push(
            `${pkg.name} is in an ISC but not in catalog ${key} — nothing to keep or delete`,
          );
          continue;
        }
        const channels = pkg.channels ?? [];
        if (channels.length === 0) {
          // oc-mirror's no-channel semantics depend on defaultChannel, which
          // bundles.json does not record — keep the whole package (spec §5.1).
          sets.fullyKept.add(k);
          for (const name of Object.keys(detail.bundles)) {
            keep(k, name);
          }
          sets.channelUnpinned.push({ catalog: key, package: pkg.name });
          continue;
        }
        for (const ch of channels) {
          const entries = detail.channels[ch.name];
          if (!entries) {
            sets.unknownChannels.push({
              catalog: key,
              package: pkg.name,
              channel: ch.name,
            });
            // Unknown channel is a data gap — keep the whole package rather
            // than emptying the keep set (shrink-only invariant, spec §8).
            sets.fullyKept.add(k);
            for (const name of Object.keys(detail.bundles)) {
              keep(k, name);
            }
            sets.warnings.push(
              `channel "${ch.name}" of ${key}/${pkg.name} not found in catalog metadata — keeping the whole package`,
            );
            continue;
          }
          const headName = resolveChannelHead(entries, detail.bundles);
          if (headName === null) {
            sets.warnings.push(
              `${pkg.name} channel ${ch.name} has no resolvable head (entry cycle?) — entire channel kept`,
            );
            for (const e of entries) {
              keep(k, e.name);
            }
            continue;
          }
          const headVersion = detail.bundles[headName]?.version ?? null;
          const min = ch.minVersion?.trim() || null;
          const bound = ch.maxVersion?.trim() || headVersion;
          for (const e of entries) {
            const version = detail.bundles[e.name]?.version ?? null;
            let kept: boolean;
            if (version === null) {
              kept = true; // can't reason → don't delete (spec §5.1)
            } else if (min === null) {
              kept = e.name === headName;
            } else {
              kept =
                cmp(version, min) >= 0 &&
                (bound === null || cmp(version, bound) <= 0);
            }
            if (kept) {
              keep(k, e.name);
            }
          }
        }
      }
    }
  }

  // Kept-images union (spec §5.2): kept bundles' image + relatedImages…
  for (const { catalog, bundles } of catalogs) {
    for (const [pkg, detail] of Object.entries(bundles.packages)) {
      const kept = sets.keptBundles.get(pkgKey(catalog, pkg));
      if (!kept) {
        continue;
      }
      for (const bundleName of kept) {
        const bundle = detail.bundles[bundleName];
        if (!bundle) {
          continue;
        }
        const owner = `${pkg} ${bundleName}`;
        for (const ref of [bundle.image, ...bundle.relatedImages]) {
          const parsed = stripImageRef(ref);
          if (!parsed) {
            continue;
          }
          if (parsed.digest) {
            if (!sets.keptDigests.has(parsed.digest)) {
              sets.keptDigests.set(parsed.digest, owner);
            }
          } else {
            const pathTag = `${parsed.path}:${parsed.tag ?? 'latest'}`;
            if (!sets.keptPathTags.has(pathTag)) {
              sets.keptPathTags.set(pathTag, owner);
            }
          }
        }
      }
    }
  }
  // …plus every current additionalImage across all ISCs.
  for (const isc of iscs) {
    for (const ai of isc.mirror?.additionalImages ?? []) {
      const ref = typeof ai?.name === 'string' ? ai.name : '';
      const parsed = stripImageRef(ref);
      if (!parsed) {
        continue;
      }
      const owner = `additionalImage ${ref}`;
      if (parsed.digest) {
        if (!sets.keptDigests.has(parsed.digest)) {
          sets.keptDigests.set(parsed.digest, owner);
        }
      } else {
        const pathTag = `${parsed.path}:${parsed.tag ?? 'latest'}`;
        if (!sets.keptPathTags.has(pathTag)) {
          sets.keptPathTags.set(pathTag, owner);
        }
      }
    }
  }
  return sets;
}

/** Shared-image guard (spec §7.2). Returns the blocking "ref → owner" text. */
function sharedImageHit(
  images: string[],
  sets: KeepSets,
  selfOwner: string,
): string | null {
  for (const ref of images) {
    const parsed = stripImageRef(ref);
    if (!parsed) {
      continue;
    }
    const owner = parsed.digest
      ? sets.keptDigests.get(parsed.digest)
      : sets.keptPathTags.get(`${parsed.path}:${parsed.tag ?? 'latest'}`);
    if (owner && owner !== selfOwner) {
      return `${ref} is also needed by ${owner}`;
    }
  }
  return null;
}

export function generateDisc(
  inputs: DiscInputs,
  options: DiscOptions,
): DiscResult {
  const { snapshot, catalogs, acm, iscs } = inputs;
  const sets = buildKeepSets(iscs, catalogs);
  const bundlesByKey = new Map(catalogs.map(c => [c.catalog, c.bundles]));
  const warnings = [...sets.warnings];

  const operators: DiscReport['operators'] = {
    candidates: [],
    held: [],
    unknownTags: [],
    unverifiableRepos: [],
    channelUnpinned: sets.channelUnpinned,
    unknownChannels: sets.unknownChannels,
    manualBundles: [],
  };
  const additionalImages: DiscReport['additionalImages'] = {
    class1: [],
    held: [],
    orphans: [],
    rejectedPicks: [],
  };

  // ACM gate health (spec §7.1).
  const badHubs = (acm?.hubs ?? []).filter(
    h => h.status !== 'ok' || h.truncated,
  );
  const acmHealthy =
    acm !== null && acm.hubs.length > 0 && badHubs.length === 0;
  let acmCause = '';
  if (!acmHealthy) {
    acmCause = !acm
      ? 'no fleet snapshot stored — refresh Fleet Operators first'
      : acm.hubs.length === 0
        ? 'the fleet snapshot contains no hubs'
        : `hub problem(s): ${badHubs
            .map(h => `${h.name} (${h.status === 'error' ? 'error' : 'truncated'})`)
            .join(', ')}`;
    warnings.push(
      `Fleet verification unavailable (${acmCause}) — ALL operator delete candidates are held back.`,
    );
  }
  if (!snapshot.walkOk) {
    warnings.push(
      'Orphan discovery incomplete — the /v2/_catalog walk failed on the last scan; orphan review items are unavailable. Rescan to rebuild them.',
    );
  }
  if (snapshot.partial) {
    warnings.push(
      `The last scan was partial (${snapshot.errors.length} issue(s)) — affected repos contribute no candidates.`,
    );
  }

  // Unverifiable repos: errored at scan time, absent from repos[] (spec §6.1).
  const presentRepos = new Set(snapshot.repos.map(r => r.repo));
  const unverifiableSeen = new Set<string>();
  for (const issue of snapshot.errors) {
    if (issue.repo && !presentRepos.has(issue.repo) && !unverifiableSeen.has(issue.repo)) {
      unverifiableSeen.add(issue.repo);
      operators.unverifiableRepos.push({
        repo: issue.repo,
        message: `${issue.message} — no candidates proposed for this repo`,
      });
    }
  }

  // Operator candidates = present − kept (spec §6.1), then gates (§7).
  const emitted = new Map<string, Map<string, Map<string, Set<string>>>>();
  let discOperatorEntries = 0;
  for (const repo of snapshot.repos) {
    if (repo.origin !== 'operator') {
      continue;
    }
    for (const tag of repo.tags) {
      if (!tag.matched) {
        operators.unknownTags.push({
          repo: repo.repo,
          tag: tag.tag,
          digest: tag.digest,
        });
        continue;
      }
      const { catalog, package: pkg, bundleName, version } = tag.matched;
      const k = pkgKey(catalog, pkg);
      if (sets.fullyKept.has(k) || sets.keptBundles.get(k)?.has(bundleName)) {
        continue;
      }
      const detail = bundlesByKey.get(catalog)?.packages[pkg];
      if (!detail) {
        continue; // catalog suppressed — warning already recorded
      }
      const manual = (reason: string): void => {
        operators.manualBundles.push({
          catalog,
          package: pkg,
          bundleName,
          version,
          repo: repo.repo,
          tag: tag.tag,
          reason,
        });
      };
      const catalogRef = sets.catalogRefs.get(catalog);
      if (!catalogRef) {
        manual('catalog is no longer referenced by any ISC — review manually');
        continue;
      }
      if (version === null) {
        manual('bundle version is unparsable — cannot express a semver range');
        continue;
      }
      const containing = Object.entries(detail.channels)
        .filter(([, entries]) => entries.some(e => e.name === bundleName))
        .map(([name]) => name)
        .sort();
      if (containing.length === 0) {
        manual(
          'bundle is in no catalog channel (skipRange-only?) — cannot express a semver range',
        );
        continue;
      }
      const candidate: OperatorCandidate = {
        catalog,
        catalogRef,
        package: pkg,
        channel: containing[0],
        version,
        bundleName,
        repo: repo.repo,
        tag: tag.tag,
        digest: tag.digest,
      };
      // Gate 1: ACM (spec §7.1).
      if (!acmHealthy) {
        operators.held.push({
          kind: 'operator',
          reason: 'acm-unverifiable',
          detail: acmCause,
          package: pkg,
          version,
          bundleName,
          repo: repo.repo,
          tag: tag.tag,
        });
        continue;
      }
      const deployedOn = (acm.packages[pkg]?.deployments ?? []).filter(
        d => norm(d.version) === norm(version),
      );
      if (deployedOn.length > 0) {
        operators.held.push({
          kind: 'operator',
          reason: 'still-deployed',
          detail: `deployed on ${deployedOn
            .map(d => `${d.cluster} @ ${d.hub}`)
            .join(', ')}`,
          package: pkg,
          version,
          bundleName,
          repo: repo.repo,
          tag: tag.tag,
        });
        continue;
      }
      // Gate 2: shared-image guard (spec §7.2).
      const bundle = detail.bundles[bundleName];
      const hit = bundle
        ? sharedImageHit(
            [bundle.image, ...bundle.relatedImages],
            sets,
            `${pkg} ${bundleName}`,
          )
        : null;
      if (hit) {
        operators.held.push({
          kind: 'operator',
          reason: 'shared-image',
          detail: hit,
          package: pkg,
          version,
          bundleName,
          repo: repo.repo,
          tag: tag.tag,
        });
        continue;
      }
      operators.candidates.push(candidate);
      // Emission dedup by (catalogRef, package, channel, version).
      let pkgs = emitted.get(catalogRef);
      if (!pkgs) {
        pkgs = new Map();
        emitted.set(catalogRef, pkgs);
      }
      let chans = pkgs.get(pkg);
      if (!chans) {
        chans = new Map();
        pkgs.set(pkg, chans);
      }
      let versions = chans.get(candidate.channel);
      if (!versions) {
        versions = new Set();
        chans.set(candidate.channel, versions);
      }
      if (!versions.has(version)) {
        versions.add(version);
        discOperatorEntries += 1;
      }
    }
  }

  // additionalImages (spec §6.2/§6.3).
  const discAdditional: string[] = [];
  for (const repo of snapshot.repos) {
    if (repo.origin === 'operator') {
      continue;
    }
    const suffix = repoSuffix(repo.repo, snapshot.pathPrefix);
    for (const tag of repo.tags) {
      if (tag.matchedAdditional) {
        continue; // kept additionalImage
      }
      if (repo.origin === 'additional' && !repo.hostAmbiguous && repo.sourceHost) {
        const sourceRef = `${repo.sourceHost}/${suffix}:${tag.tag}`;
        const hit = sharedImageHit([sourceRef], sets, '') ??
          (tag.digest && sets.keptDigests.has(tag.digest)
            ? `${sourceRef} shares digest ${tag.digest} with ${sets.keptDigests.get(tag.digest)}`
            : null);
        if (hit) {
          additionalImages.held.push({
            kind: 'additional-image',
            reason: 'shared-image',
            detail: hit,
            repo: repo.repo,
            tag: tag.tag,
          });
          continue;
        }
        additionalImages.class1.push({
          repo: repo.repo,
          tag: tag.tag,
          digest: tag.digest,
          sourceRef,
        });
        continue;
      }
      // Class 2: walk orphans + host-ambiguous downgrades (spec §6.3).
      if (snapshot.walkOk || repo.origin === 'additional') {
        const pathTag = `${suffix}:${tag.tag}`;
        if (
          sets.keptPathTags.has(pathTag) ||
          (tag.digest && sets.keptDigests.has(tag.digest))
        ) {
          // Matches a kept image (e.g. the mirrored catalog index) — never
          // offered as a pickable orphan (spec §7.2/§9).
          continue;
        }
        additionalImages.orphans.push({
          repo: repo.repo,
          tag: tag.tag,
          digest: tag.digest,
          suggestedRef: `${DEFAULT_ORPHAN_HOST}/${suffix}:${tag.tag}`,
          hostAmbiguous: repo.origin === 'additional',
        });
      }
    }
  }

  // Orphan picks: stateless re-validation against the snapshot (spec §6.3).
  const acceptedPicks: AdditionalCandidate[] = [];
  for (const pick of options.includeOrphans) {
    const repo = snapshot.repos.find(r => r.repo === pick.repo);
    const reject = (reason: string): void => {
      additionalImages.rejectedPicks.push({
        repo: pick.repo,
        tag: pick.tag,
        reason,
      });
    };
    if (!repo) {
      reject('repo is not in the scan snapshot');
      continue;
    }
    if (repo.origin === 'walk' && !snapshot.walkOk) {
      reject('orphan discovery incomplete — rescan before picking walk repos');
      continue;
    }
    if (
      repo.origin === 'operator' ||
      (repo.origin === 'additional' && !repo.hostAmbiguous)
    ) {
      reject('not an orphan repo — only walk or host-ambiguous repos are pickable');
      continue;
    }
    const tag = repo.tags.find(t => t.tag === pick.tag);
    if (!tag) {
      reject('tag is not in the scan snapshot');
      continue;
    }
    const parsed = stripImageRef(pick.sourceRef);
    if (!parsed || (parsed.tag ?? 'latest') !== pick.tag) {
      reject('sourceRef does not parse to a <host>/<path>:<tag> ref matching the tag');
      continue;
    }
    if (parsed.path !== repoSuffix(pick.repo, snapshot.pathPrefix)) {
      reject('sourceRef path does not match the mirrored repo path');
      continue;
    }
    const hit =
      sharedImageHit([pick.sourceRef], sets, '') ??
      (tag.digest && sets.keptDigests.has(tag.digest)
        ? `shares digest ${tag.digest} with ${sets.keptDigests.get(tag.digest)}`
        : null);
    if (hit) {
      reject(`shared image: ${hit}`);
      continue;
    }
    acceptedPicks.push({
      repo: pick.repo,
      tag: pick.tag,
      digest: tag.digest,
      sourceRef: pick.sourceRef,
    });
  }

  if (options.includeAdditionalImages) {
    for (const c of [...additionalImages.class1, ...acceptedPicks]) {
      if (!discAdditional.includes(c.sourceRef)) {
        discAdditional.push(c.sourceRef);
      }
    }
    discAdditional.sort();
  }

  // Emit the DISC (spec §9). Never the catalog index image.
  const operatorSections = [...emitted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([catalogRef, pkgs]) => ({
      catalog: catalogRef,
      packages: [...pkgs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, chans]) => ({
          name,
          channels: [...chans.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([channel, versions]) =>
              [...versions]
                .sort(cmp)
                .map(v => ({ name: channel, minVersion: v, maxVersion: v })),
            ),
        })),
    }));
  const doc = {
    apiVersion: 'mirror.openshift.io/v2alpha1',
    kind: 'DeleteImageSetConfiguration',
    delete: {
      ...(operatorSections.length ? { operators: operatorSections } : {}),
      ...(options.includeAdditionalImages && discAdditional.length
        ? { additionalImages: discAdditional.map(name => ({ name })) }
        : {}),
    },
  };

  const strictViolation =
    options.strict &&
    operators.held.some(
      h => h.reason === 'still-deployed' || h.reason === 'acm-unverifiable',
    );

  return {
    discYaml: YAML.stringify(doc),
    strictViolation,
    report: {
      registryId: snapshot.registryId,
      host: snapshot.host,
      pathPrefix: snapshot.pathPrefix,
      scannedAt: snapshot.scannedAt,
      acmRefreshedAt: acm?.refreshedAt ?? null,
      walkOk: snapshot.walkOk,
      warnings,
      operators,
      additionalImages,
      stats: {
        discOperatorEntries,
        discAdditionalImages: options.includeAdditionalImages
          ? discAdditional.length
          : 0,
      },
    },
  };
}
