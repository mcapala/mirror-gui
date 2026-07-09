import { compareVersionStrings } from '../utils.js';
import type { DeployedOperatorSnapshot } from './types.js';

// --- Types (see plan Interfaces block; copy verbatim) ---

export type SuggestionKind =
  | 'raise-min-version'
  | 'lower-min-version-drift'
  | 'raise-platform-min-version'
  | 'add-channel'
  | 'add-operator'
  | 'remove-channel'
  | 'remove-operator'
  | 'reset-unused-operator';

export type SuggestionPath =
  | { type: 'operator-channel'; catalog: string; package: string; channel: string }
  | { type: 'operator'; catalog: string; package: string }
  | { type: 'platform-channel'; channel: string };

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  path: SuggestionPath;
  current: string | null;
  proposed: string | null;
  proposedChannels?: { name: string; minVersion: string }[];
  evidence: string;
  /** Operator-scoped explanations shown in the row's expandable area. */
  notes?: string[];
  defaultChecked: boolean;
}

export interface BehindReportEntry {
  package: string;
  latestAvailable: string | null;
  behindClusters: { cluster: string; hub: string; version: string }[];
}

export interface NoDataEntry {
  package: string;
  reason: 'no-fleet-data' | 'not-in-catalog' | 'catalog-unavailable';
}

export interface ReconcileResult {
  suggestions: Suggestion[];
  report: BehindReportEntry[];
  noData: NoDataEntry[];
  warnings: string[];
}

export interface CatalogOperatorDetail {
  defaultChannel: string | null;
  channelVersions: Record<string, string[]>;
}

export type ReconcileCatalog = Map<string, Map<string, CatalogOperatorDetail>>;

export interface IscOperatorChannel { name: string; minVersion?: string; maxVersion?: string }

export interface IscOperatorPackage { name: string; channels?: IscOperatorChannel[] }

export interface IscOperatorCatalog { catalog: string; packages?: IscOperatorPackage[]; full?: boolean }

export interface IscPlatformChannel { name: string; minVersion?: string; maxVersion?: string }

export interface IscConfig {
  kind: string;
  apiVersion: string;
  mirror?: {
    platform?: { channels?: IscPlatformChannel[] };
    operators?: IscOperatorCatalog[];
    additionalImages?: Array<{ name: string }>;
  };
}

export function catalogKeyFromUrl(catalogUrl: string): string | null {
  if (!catalogUrl || catalogUrl.includes('@')) {
    return null;
  }
  const match = catalogUrl.match(/([^/:]+):([^/:]+)$/);
  if (!match) {
    return null;
  }
  return `${match[1]}:${match[2]}`;
}

export function buildReconcileCatalog(
  data: {
    operators: Record<
      string,
      Array<{
        name: string;
        defaultChannel?: string;
        channelVersions?: Record<string, string[]>;
      }>
    >;
  } | null,
): ReconcileCatalog {
  const catalog: ReconcileCatalog = new Map();
  if (!data?.operators) {
    return catalog;
  }
  for (const [key, operators] of Object.entries(data.operators)) {
    const byName = new Map<string, CatalogOperatorDetail>();
    for (const op of operators) {
      byName.set(op.name, {
        defaultChannel: op.defaultChannel ?? null,
        channelVersions: op.channelVersions ?? {},
      });
    }
    catalog.set(key, byName);
  }
  return catalog;
}

export function buildCatalogUrlMap(
  data: {
    operators?: Record<string, unknown>;
    index?: {
      catalogs?: Array<{
        catalog_type: string;
        ocp_version: string;
        catalog_url?: string;
      }>;
    };
  } | null,
): Map<string, string> {
  const urls = new Map<string, string>();
  for (const entry of data?.index?.catalogs ?? []) {
    if (entry.catalog_url) {
      urls.set(`${entry.catalog_type}:${entry.ocp_version}`, entry.catalog_url);
    }
  }
  for (const key of Object.keys(data?.operators ?? {})) {
    if (!urls.has(key)) {
      // sync-catalogs.sh only mirrors Red Hat indexes; keys are "<name>:<tag>"
      // and Red Hat indexes all live under registry.redhat.io/redhat/
      urls.set(key, `registry.redhat.io/redhat/${key}`);
    }
  }
  return urls;
}

const minOf = (versions: string[]): string =>
  versions.reduce((a, b) => (compareVersionStrings(a, b) <= 0 ? a : b));

const maxOf = (versions: string[]): string =>
  versions.reduce((a, b) => (compareVersionStrings(a, b) >= 0 ? a : b));

function suggestionId(
  kind: SuggestionKind,
  path: SuggestionPath,
): string {
  if (path.type === 'platform-channel') {
    return `${kind}|platform||${path.channel}`;
  }
  const channel = path.type === 'operator-channel' ? path.channel : '';
  return `${kind}|${path.catalog}|${path.package}|${channel}`;
}

/** Numeric compare of the ":vX.Y" tags of two catalog keys (lexical would put v4.9 above v4.21). */
function compareCatalogKeyTags(a: string, b: string): number {
  const parts = (key: string): number[] =>
    (key.split(':').pop() ?? '')
      .replace(/^v/, '')
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return a.localeCompare(b);
}

/**
 * Per-package catalog update: when deployed versions attribute to no
 * channel of the selected tag but do attribute in a newer synced tag of
 * the same index, offer an add row (mirror the package from the target
 * tag; covering channels only — channels the old entry still serves are
 * not carried) and, independently, a remove row (drop the package from
 * the old entry) when nothing deployed actually runs from it. Check both
 * = full move; add only = transition split (both tags mirrored).
 */
function planPackageCatalogUpdate(args: {
  catEntry: IscOperatorCatalog;
  pkg: IscOperatorPackage;
  key: string;
  detail: CatalogOperatorDetail;
  unattributed: string[];
  versions: string[];
  config: IscConfig;
  catalog: ReconcileCatalog;
  catalogUrls: Map<string, string>;
  snapshot: DeployedOperatorSnapshot;
  trustworthy: boolean;
  fleetScope: string;
}): { rows: Suggestion[]; hasAdd: boolean; hasRemove: boolean } {
  const {
    catEntry, pkg, key, detail, unattributed, versions, config,
    catalog, catalogUrls, snapshot, trustworthy, fleetScope,
  } = args;
  const rows: Suggestion[] = [];
  const none = { rows, hasAdd: false, hasRemove: false };
  if (unattributed.length === 0) {
    return none;
  }
  const oldTag = key.split(':')[1];

  // --- add row: find the newest newer tag attributing all stray versions
  const indexName = key.split(':')[0];
  const newerKeys = [...catalog.keys()]
    .filter(k => k.split(':')[0] === indexName && compareCatalogKeyTags(k, key) > 0)
    .sort(compareCatalogKeyTags)
    .reverse();
  const attributesAll = (k: string): boolean => {
    const d = catalog.get(k)?.get(pkg.name);
    return (
      !!d &&
      unattributed.every(v =>
        Object.values(d.channelVersions).some(vs => vs.includes(v)),
      )
    );
  };
  const targetKey = newerKeys.find(attributesAll);
  let hasAdd = false;
  if (targetKey) {
    const targetDetail = catalog.get(targetKey)!.get(pkg.name)!;
    const newTag = targetKey.split(':')[1];
    const targetUrl =
      catalogUrls.get(targetKey) ??
      catEntry.catalog.replace(/:[^/:]+$/, `:${newTag}`);
    const inTarget = (channelName: string, version: string): boolean =>
      (targetDetail.channelVersions[channelName] ?? []).includes(version);
    // covering channels for the stray versions only
    const covering: { name: string; minVersion: string }[] = [];
    for (const version of unattributed) {
      if (covering.some(ch => inTarget(ch.name, version))) {
        continue;
      }
      const hosts = Object.keys(targetDetail.channelVersions)
        .filter(channelName => inTarget(channelName, version))
        .sort();
      const channelName =
        targetDetail.defaultChannel && hosts.includes(targetDetail.defaultChannel)
          ? targetDetail.defaultChannel
          : hosts[0];
      const attributedHere = versions.filter(v => inTarget(channelName, v));
      covering.push({ name: channelName, minVersion: minOf(attributedHere) });
    }
    const example = unattributed[0];
    const pin = snapshot.packages[pkg.name]?.deployments.find(
      d => d.version === example,
    );
    const pinText = pin ? `${pin.cluster} @ ${pin.hub}` : 'unknown cluster';
    const first = covering[0];
    const isDefault = first.name === targetDetail.defaultChannel;
    const evidence =
      `${pkg.name} runs ${example} (${pinText}) — in no channel of ` +
      `${oldTag}; ${first.name} ` +
      (isDefault
        ? `is ${newTag}'s default channel and contains it`
        : `contains it in ${newTag}`);
    const targetEntry = (config.mirror?.operators ?? []).find(
      e => e.catalog === targetUrl,
    );
    const targetPkg = targetEntry?.packages?.find(p => p.name === pkg.name);
    if (targetPkg) {
      // entry + package already mirrored from the target tag: only the
      // covering channels can be missing
      for (const ch of covering) {
        if (targetPkg.channels?.some(c => c.name === ch.name)) {
          continue;
        }
        const path: SuggestionPath = {
          type: 'operator-channel',
          catalog: targetUrl,
          package: pkg.name,
          channel: ch.name,
        };
        rows.push({
          id: suggestionId('add-channel', path),
          kind: 'add-channel',
          path,
          current: null,
          proposed: ch.minVersion,
          evidence,
          defaultChecked: true,
        });
        hasAdd = true;
      }
    } else {
      const path: SuggestionPath = {
        type: 'operator',
        catalog: targetUrl,
        package: pkg.name,
      };
      rows.push({
        id: suggestionId('add-operator', path),
        kind: 'add-operator',
        path,
        current: null,
        proposed: covering
          .map(ch => `${ch.name}@${ch.minVersion}`)
          .join(', '),
        proposedChannels: covering,
        evidence,
        defaultChecked: true,
      });
      hasAdd = true;
    }
  }

  // --- remove row: independent of the add row's shape, but only offered
  // when a newer tag actually hosts the stray versions (no qualifying key
  // → no pair, today's fallback applies) and the old entry serves nothing
  // that actually runs, so a remove applied alone never loses real
  // coverage
  const servedOnOld = versions.some(v =>
    (pkg.channels ?? []).some(ch =>
      (detail.channelVersions[ch.name] ?? []).includes(v),
    ),
  );
  let hasRemove = false;
  if (targetKey && trustworthy && !servedOnOld) {
    const path: SuggestionPath = {
      type: 'operator',
      catalog: catEntry.catalog,
      package: pkg.name,
    };
    rows.push({
      id: suggestionId('remove-operator', path),
      kind: 'remove-operator',
      path,
      current:
        (pkg.channels ?? [])
          .map(c => c.name + (c.minVersion ? `@${c.minVersion}` : ''))
          .join(', ') || null,
      proposed: null,
      evidence:
        `no deployed version runs ${pkg.name} from ${oldTag} across ` +
        `${fleetScope} (deployed: ${[...new Set(versions)].join(', ')}, ` +
        `in no ${oldTag} channel) — remove it here after adding it to a ` +
        'newer catalog. Already-mirrored images are untouched.',
      defaultChecked: false,
    });
    hasRemove = true;
  }
  return { rows, hasAdd, hasRemove };
}

function seedFromEmptyIsc(
  snapshot: DeployedOperatorSnapshot,
  catalog: ReconcileCatalog,
  catalogUrls: Map<string, string>,
  fleetScope: string,
  suggestions: Suggestion[],
  warnings: string[],
): void {
  for (const [packageName, snapPkg] of Object.entries(snapshot.packages)) {
    const hosts = [...catalog.entries()]
      .filter(([, ops]) => ops.has(packageName))
      .map(([key]) => key)
      .sort();
    if (hosts.length === 0) {
      warnings.push(
        `${packageName} is deployed (${snapPkg.deployments.length} deployment(s)) ` +
          'but is in no bundled catalog — add it manually if it should be mirrored.',
      );
      continue;
    }
    const preferred = hosts.filter(k =>
      k.startsWith('redhat-operator-index:'),
    );
    // several OCP versions of the preferred index can host the package — seed
    // from the newest one
    const key = preferred.length
      ? preferred.reduce((a, b) => (compareCatalogKeyTags(a, b) >= 0 ? a : b))
      : hosts[0];
    const notes: string[] = [];
    if (hosts.length > 1) {
      notes.push(
        `${packageName} exists in ${hosts.length} catalogs ` +
          `(${hosts.join(', ')}) — chose ${key}.`,
      );
    }
    const detail = catalog.get(key)!.get(packageName)!;
    const versions = snapPkg.deployments.map(d => d.version);
    const withDeployed = Object.keys(detail.channelVersions)
      .filter(ch =>
        versions.some(v => detail.channelVersions[ch].includes(v)),
      )
      .sort();
    let channelName: string;
    if (withDeployed.length > 0) {
      channelName =
        detail.defaultChannel && withDeployed.includes(detail.defaultChannel)
          ? detail.defaultChannel
          : withDeployed[0];
    } else if (
      detail.defaultChannel &&
      detail.channelVersions[detail.defaultChannel]
    ) {
      channelName = detail.defaultChannel;
      notes.push(
        `${packageName}: no deployed version is in any catalog channel — ` +
          'proposing the default channel with the numeric floor.',
      );
    } else {
      warnings.push(
        `${packageName} is deployed but its catalog entry has no usable channels — add it manually.`,
      );
      continue;
    }
    const floor = minOf(versions);
    const catalogUrl =
      catalogUrls.get(key) ?? `registry.redhat.io/redhat/${key}`;
    const path: SuggestionPath = {
      type: 'operator',
      catalog: catalogUrl,
      package: packageName,
    };
    suggestions.push({
      id: suggestionId('add-operator', path),
      kind: 'add-operator',
      path,
      current: null,
      proposed: `${channelName}@${floor}`,
      proposedChannels: [{ name: channelName, minVersion: floor }],
      evidence:
        `${packageName} is deployed on ${snapPkg.deployments.length} ` +
        `deployment(s) across ${fleetScope} but the ISC has no operator entries`,
      defaultChecked: false,
      ...(notes.length ? { notes } : {}),
    });
  }
}

export function reconcile(
  config: IscConfig,
  snapshot: DeployedOperatorSnapshot,
  catalog: ReconcileCatalog,
  catalogUrls: Map<string, string> = new Map(),
): ReconcileResult {
  const suggestions: Suggestion[] = [];
  const report: BehindReportEntry[] = [];
  const noData: NoDataEntry[] = [];
  const warnings: string[] = [];

  const badHubs = snapshot.hubs.filter(
    h => h.status !== 'ok' || h.truncated,
  );
  const trustworthy = snapshot.hubs.length > 0 && badHubs.length === 0;
  if (!trustworthy) {
    const causes = badHubs.length
      ? badHubs
          .map(
            h => `${h.name} (${h.status === 'error' ? 'error' : 'truncated'})`,
          )
          .join(', ')
      : 'no hubs in snapshot';
    warnings.push(
      `Channel-removal and unused-operator-reset suggestions are suppressed: ${causes}. ` +
        'A hub gap could hide the cluster still using a channel.',
    );
  }
  const fleetScope = `${snapshot.clusters.length} cluster(s) on ${snapshot.hubs.length} hub(s)`;

  for (const catEntry of config.mirror?.operators ?? []) {
    const key = catalogKeyFromUrl(catEntry.catalog ?? '');
    const catOps = key ? catalog.get(key) : undefined;
    if (!catOps) {
      warnings.push(
        `Catalog "${catEntry.catalog}" is not in the bundled catalog data — ` +
          'its packages cannot be reconciled against catalog channels.',
      );
    }

    for (const pkg of catEntry.packages ?? []) {
      const snapPkg = snapshot.packages[pkg.name];
      const detail = catOps?.get(pkg.name);
      const channels = pkg.channels ?? [];

      if (!detail) {
        noData.push({
          package: pkg.name,
          reason: catOps ? 'not-in-catalog' : 'catalog-unavailable',
        });
        if (!snapPkg) {
          continue;
        }
      }

      if (!snapPkg) {
        noData.push({ package: pkg.name, reason: 'no-fleet-data' });
        if (trustworthy && detail?.defaultChannel) {
          const headVersions =
            detail.channelVersions[detail.defaultChannel] ?? [];
          if (headVersions.length > 0) {
            const head = maxOf(headVersions);
            const alreadyReset =
              channels.length === 1 &&
              channels[0].name === detail.defaultChannel &&
              (channels[0].minVersion?.trim() || '') === head;
            if (!alreadyReset) {
              const path: SuggestionPath = {
                type: 'operator',
                catalog: catEntry.catalog,
                package: pkg.name,
              };
              suggestions.push({
                id: suggestionId('reset-unused-operator', path),
                kind: 'reset-unused-operator',
                path,
                current: channels
                  .map(c => c.name + (c.minVersion ? `@${c.minVersion}` : ''))
                  .join(', ') || null,
                proposed: `${detail.defaultChannel}@${head}`,
                proposedChannels: [
                  { name: detail.defaultChannel, minVersion: head },
                ],
                evidence:
                  `${pkg.name} is not deployed anywhere across ${fleetScope} — ` +
                  'switch to the default channel at its head to mirror only the ' +
                  'newest content. Already-mirrored images are untouched.',
                defaultChecked: false,
              });
            }
          }
        }
        continue;
      }

      if (snapPkg.status === 'behind') {
        report.push({
          package: pkg.name,
          latestAvailable: snapPkg.latestAvailable,
          behindClusters: snapPkg.deployments
            .filter(d => d.behind)
            .map(d => ({
              cluster: d.cluster,
              hub: d.hub,
              version: d.version,
            })),
        });
      }

      if (!detail) {
        continue;
      }

      const versions = snapPkg.deployments.map(d => d.version);
      const inChannel = (version: string, channel: string): boolean =>
        (detail.channelVersions[channel] ?? []).includes(version);
      const unattributed = [
        ...new Set(
          versions.filter(
            v =>
              !Object.keys(detail.channelVersions).some(c => inChannel(v, c)),
          ),
        ),
      ];
      const update = key && detail
        ? planPackageCatalogUpdate({
            catEntry, pkg, key, detail, unattributed, versions, config,
            catalog, catalogUrls, snapshot, trustworthy, fleetScope,
          })
        : { rows: [], hasAdd: false, hasRemove: false };
      suggestions.push(...update.rows);
      if (unattributed.length > 0 && !update.hasAdd) {
        warnings.push(
          `${pkg.name}: deployed version(s) ${unattributed.join(', ')} are in no ` +
            'catalog channel (skipRange-only upgrade graph?) — using numeric ' +
            'comparison for floors; channel removals are disabled for this package.',
        );
      }
      const removalsAllowed =
        trustworthy && unattributed.length === 0 && !update.hasRemove;
      const pkgFloor = minOf(versions);

      for (const ch of channels) {
        const chVersions = detail.channelVersions[ch.name];
        if (!chVersions) {
          warnings.push(
            `${pkg.name}: ISC channel "${ch.name}" is not in the catalog data — skipped.`,
          );
          continue;
        }
        const attributed = versions.filter(v => inChannel(v, ch.name));
        let floor: string | null = null;
        if (unattributed.length > 0 && !update.hasAdd) {
          // minVersion is a floor filter, so a value below the channel's
          // entries is fine — but one above the channel head would filter
          // out every version the channel has (numaresources 4.22.1 into
          // channel "4.21"): propose nothing instead
          if (compareVersionStrings(pkgFloor, maxOf(chVersions)) <= 0) {
            floor = pkgFloor;
          } else if (attributed.length > 0) {
            floor = minOf(attributed);
          }
        } else if (attributed.length > 0) {
          floor = minOf(attributed);
        }
        const path: SuggestionPath = {
          type: 'operator-channel',
          catalog: catEntry.catalog,
          package: pkg.name,
          channel: ch.name,
        };
        if (floor === null) {
          if (removalsAllowed) {
            suggestions.push({
              id: suggestionId('remove-channel', path),
              kind: 'remove-channel',
              path,
              current: ch.minVersion?.trim() || null,
              proposed: null,
              evidence:
                `no deployed version of ${pkg.name} attributes to ` +
                `${ch.name} across ${fleetScope}. Removing only stops future ` +
                'mirroring; already-mirrored images are untouched.',
              defaultChecked: false,
            });
          }
          continue;
        }
        const current = ch.minVersion?.trim() || null;
        const pin = snapPkg.deployments.find(d => d.version === floor);
        const pinText = pin ? `${pin.cluster} @ ${pin.hub}` : 'unknown cluster';
        if (current === null || compareVersionStrings(floor, current) > 0) {
          suggestions.push({
            id: suggestionId('raise-min-version', path),
            kind: 'raise-min-version',
            path,
            current,
            proposed: floor,
            evidence: `floor pinned by ${pinText} (${floor})`,
            defaultChecked: true,
          });
        } else if (compareVersionStrings(floor, current) < 0) {
          suggestions.push({
            id: suggestionId('lower-min-version-drift', path),
            kind: 'lower-min-version-drift',
            path,
            current,
            proposed: floor,
            evidence:
              `DRIFT: ${pinText} runs ${floor}, below the current ` +
              `minVersion ${current} — the mirror no longer covers it`,
            defaultChecked: true,
          });
        }
      }
      const selectedVersions = channels.flatMap(
        ch => detail.channelVersions[ch.name] ?? [],
      );
      const maxSelected = selectedVersions.length
        ? maxOf(selectedVersions)
        : null;
      if (maxSelected !== null) {
        for (const [channelName, channelVersions] of Object.entries(
          detail.channelVersions,
        )) {
          if (
            channels.some(ch => ch.name === channelName) ||
            channelVersions.length === 0
          ) {
            continue;
          }
          const head = maxOf(channelVersions);
          if (compareVersionStrings(head, maxSelected) <= 0) {
            continue;
          }
          const attributedToNew = versions.filter(v =>
            channelVersions.includes(v),
          );
          const path: SuggestionPath = {
            type: 'operator-channel',
            catalog: catEntry.catalog,
            package: pkg.name,
            channel: channelName,
          };
          suggestions.push({
            id: suggestionId('add-channel', path),
            kind: 'add-channel',
            path,
            current: null,
            proposed: attributedToNew.length
              ? minOf(attributedToNew)
              : head,
            evidence: attributedToNew.length
              ? `channel ${channelName} (head ${head}) is newer than any selected ` +
                `channel and ${attributedToNew.length} deployment(s) already run versions from it`
              : `channel ${channelName} (head ${head}) is newer than any selected channel in the catalog`,
            defaultChecked: false,
          });
        }
      }
    }
  }

  if ((config.mirror?.operators ?? []).length === 0) {
    seedFromEmptyIsc(
      snapshot,
      catalog,
      catalogUrls,
      fleetScope,
      suggestions,
      warnings,
    );
  } else {
    const iscPackageNames = new Set(
      (config.mirror?.operators ?? []).flatMap(entry =>
        (entry.packages ?? []).map(pkg => pkg.name),
      ),
    );
    for (const [packageName, snapPkg] of Object.entries(snapshot.packages)) {
      if (iscPackageNames.has(packageName)) {
        continue;
      }
      let host: { catalogUrl: string; detail: CatalogOperatorDetail } | null =
        null;
      for (const catEntry of config.mirror?.operators ?? []) {
        const key = catalogKeyFromUrl(catEntry.catalog ?? '');
        const detail = key ? catalog.get(key)?.get(packageName) : undefined;
        if (detail) {
          host = { catalogUrl: catEntry.catalog, detail };
          break;
        }
      }
      if (!host) {
        warnings.push(
          `${packageName} is deployed (${snapPkg.deployments.length} deployment(s)) ` +
            'but is in no ISC catalog — add it manually if it should be mirrored.',
        );
        continue;
      }
      const notes: string[] = [];
      const versions = snapPkg.deployments.map(d => d.version);
      const pkgFloor = minOf(versions);
      const channelsWithDeployments = Object.entries(
        host.detail.channelVersions,
      ).filter(([, channelVersions]) =>
        versions.some(v => channelVersions.includes(v)),
      );
      const unattributed = versions.filter(
        v => !channelsWithDeployments.some(([, vs]) => vs.includes(v)),
      );
      let proposedChannels: { name: string; minVersion: string }[];
      if (channelsWithDeployments.length > 0) {
        proposedChannels = channelsWithDeployments.map(
          ([name, channelVersions]) => ({
            name,
            minVersion:
              unattributed.length > 0
                ? pkgFloor
                : minOf(versions.filter(v => channelVersions.includes(v))),
          }),
        );
        if (unattributed.length > 0) {
          notes.push(
            `${packageName}: deployed version(s) ${[...new Set(unattributed)].join(', ')} ` +
              'are in no catalog channel — proposed minVersions use the numeric floor.',
          );
        }
      } else if (
        host.detail.defaultChannel &&
        host.detail.channelVersions[host.detail.defaultChannel]
      ) {
        proposedChannels = [
          { name: host.detail.defaultChannel, minVersion: pkgFloor },
        ];
        notes.push(
          `${packageName}: no deployed version is in any catalog channel — ` +
            'proposing the default channel with the numeric floor.',
        );
      } else {
        warnings.push(
          `${packageName} is deployed but its catalog entry has no usable channels — add it manually.`,
        );
        continue;
      }
      const path: SuggestionPath = {
        type: 'operator',
        catalog: host.catalogUrl,
        package: packageName,
      };
      suggestions.push({
        id: suggestionId('add-operator', path),
        kind: 'add-operator',
        path,
        current: null,
        proposed: proposedChannels
          .map(ch => `${ch.name}@${ch.minVersion}`)
          .join(', '),
        proposedChannels,
        evidence:
          `${packageName} is deployed on ${snapPkg.deployments.length} ` +
          `deployment(s) across ${fleetScope} but missing from the ISC`,
        defaultChecked: false,
        ...(notes.length ? { notes } : {}),
      });
    }
  }

  const platformChannels = config.mirror?.platform?.channels ?? [];
  if (platformChannels.length > 0) {
    const coveredMinors = new Set<string>();
    for (const pch of platformChannels) {
      const minorMatch = (pch.name ?? '').match(/(\d+\.\d+)$/);
      if (!minorMatch) {
        warnings.push(
          `platform channel "${pch.name}" has no recognizable x.y suffix — skipped.`,
        );
        continue;
      }
      const minor = minorMatch[1];
      coveredMinors.add(minor);
      const attributed = snapshot.clusters.filter(
        c =>
          c.openshiftVersion === minor ||
          c.openshiftVersion.startsWith(`${minor}.`),
      );
      const path: SuggestionPath = {
        type: 'platform-channel',
        channel: pch.name,
      };
      if (attributed.length === 0) {
        if (trustworthy && snapshot.clusters.length > 0) {
          suggestions.push({
            id: suggestionId('remove-channel', path),
            kind: 'remove-channel',
            path,
            current: pch.minVersion?.trim() || null,
            proposed: null,
            evidence:
              `no managed cluster runs OpenShift ${minor}.x across ${fleetScope}. ` +
              'Removing only stops future mirroring.',
            defaultChecked: false,
          });
        }
        continue;
      }
      const floor = minOf(attributed.map(c => c.openshiftVersion));
      const pin = attributed.find(c => c.openshiftVersion === floor);
      const pinText = pin ? `${pin.cluster} @ ${pin.hub}` : 'unknown cluster';
      const current = pch.minVersion?.trim() || null;
      const max = pch.maxVersion?.trim() || null;
      if (max && compareVersionStrings(floor, max) > 0) {
        warnings.push(
          `platform channel "${pch.name}": deployed floor ${floor} is above the ` +
            `configured maxVersion ${max} — raise or clear maxVersion manually.`,
        );
        continue;
      }
      if (current === null || compareVersionStrings(floor, current) > 0) {
        suggestions.push({
          id: suggestionId('raise-platform-min-version', path),
          kind: 'raise-platform-min-version',
          path,
          current,
          proposed: floor,
          evidence: `floor pinned by ${pinText} (${floor})`,
          defaultChecked: true,
        });
      } else if (compareVersionStrings(floor, current) < 0) {
        suggestions.push({
          id: suggestionId('lower-min-version-drift', path),
          kind: 'lower-min-version-drift',
          path,
          current,
          proposed: floor,
          evidence:
            `DRIFT: ${pinText} runs ${floor}, below the current ` +
            `minVersion ${current} — the mirror no longer covers it`,
          defaultChecked: true,
        });
      }
    }
    const uncovered = new Map<string, string[]>();
    for (const cluster of snapshot.clusters) {
      const minorMatch = cluster.openshiftVersion.match(/^(\d+\.\d+)/);
      if (minorMatch && !coveredMinors.has(minorMatch[1])) {
        const list = uncovered.get(minorMatch[1]) ?? [];
        list.push(cluster.cluster);
        uncovered.set(minorMatch[1], list);
      }
    }
    for (const [minor, clusterNames] of uncovered) {
      warnings.push(
        `cluster(s) ${clusterNames.join(', ')} run OpenShift ${minor}.x, ` +
          'which no ISC platform channel covers.',
      );
    }
  }

  return { suggestions, report, noData, warnings };
}
