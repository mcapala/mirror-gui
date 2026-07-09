import type { ImageSetConfig, OperatorPackage } from '../MirrorConfig';
import type { Suggestion } from './types';

export interface ApplyResult {
  config: ImageSetConfig;
  applied: number;
  skipped: string[];
}

function findPackage(
  config: ImageSetConfig,
  catalog: string,
  packageName: string,
): OperatorPackage | undefined {
  return config.mirror.operators
    .find(entry => entry.catalog === catalog)
    ?.packages.find(pkg => pkg.name === packageName);
}

export function applySuggestions(
  config: ImageSetConfig,
  suggestions: Suggestion[],
): ApplyResult {
  const next: ImageSetConfig = structuredClone(config);
  let applied = 0;
  const skipped: string[] = [];

  // Additive suggestions first, then catalog bumps (so raises land before
  // packages move entries), removals last so a batched channel swap never
  // trips the "would leave the package without channels" guard on the
  // pre-add state.
  const ordered = [
    ...suggestions.filter(
      s => s.kind !== 'remove-channel' && s.kind !== 'bump-catalog',
    ),
    ...suggestions.filter(s => s.kind === 'bump-catalog'),
    ...suggestions.filter(s => s.kind === 'remove-channel'),
  ];

  for (const suggestion of ordered) {
    const { kind, path } = suggestion;

    if (path.type === 'platform-channel') {
      const channels = next.mirror.platform.channels;
      const channel = channels.find(ch => ch.name === path.channel);
      if (kind === 'remove-channel') {
        if (!channel) {
          skipped.push(`platform channel ${path.channel} not found`);
          continue;
        }
        next.mirror.platform.channels = channels.filter(
          ch => ch.name !== path.channel,
        );
        applied++;
      } else if (channel && suggestion.proposed) {
        channel.minVersion = suggestion.proposed;
        applied++;
      } else {
        skipped.push(`platform channel ${path.channel} not found`);
      }
      continue;
    }

    if (path.type === 'catalog') {
      if (
        kind !== 'bump-catalog' ||
        !suggestion.proposedCatalog ||
        !suggestion.movedPackages
      ) {
        skipped.push(`unsupported catalog-level suggestion on ${path.catalog}`);
        continue;
      }
      const oldEntry = next.mirror.operators.find(
        e => e.catalog === path.catalog,
      );
      if (!oldEntry) {
        skipped.push(`catalog ${path.catalog} not found`);
        continue;
      }
      let target = next.mirror.operators.find(
        e => e.catalog === suggestion.proposedCatalog,
      );
      if (!target) {
        // same shape as the add-operator entry creation: the metadata
        // rehydrate effect fills availableOperators after the apply
        target = {
          catalog: suggestion.proposedCatalog,
          catalogVersion: suggestion.proposedCatalog.match(/:([^/:]+)$/)?.[1],
          availableOperators: [],
          packages: [],
        };
        next.mirror.operators.push(target);
      }
      let moved = 0;
      for (const name of suggestion.movedPackages) {
        const index = oldEntry.packages.findIndex(p => p.name === name);
        if (index === -1) {
          skipped.push(`${name} not found in ${path.catalog}`);
          continue;
        }
        if (target.packages.some(p => p.name === name)) {
          skipped.push(
            `${name} already present in ${suggestion.proposedCatalog}`,
          );
          continue;
        }
        const pkg = oldEntry.packages.splice(index, 1)[0];
        const rewrite = suggestion.channelRewrites?.[name];
        if (rewrite) {
          pkg.channels = rewrite.map(ch => ({
            name: ch.name,
            minVersion: ch.minVersion,
          }));
        }
        target.packages.push(pkg);
        moved++;
      }
      if (moved > 0) {
        applied++;
      }
      if (oldEntry.packages.length === 0) {
        next.mirror.operators = next.mirror.operators.filter(
          e => e !== oldEntry,
        );
      }
      continue;
    }

    if (path.type === 'operator') {
      let entry = next.mirror.operators.find(e => e.catalog === path.catalog);
      if (!entry) {
        if (kind === 'add-operator' && suggestion.proposedChannels) {
          // seeded suggestion on an ISC without this catalog — create the
          // entry; MirrorConfig's metadata rehydrate effect fills
          // availableOperators after the apply
          entry = {
            catalog: path.catalog,
            catalogVersion: path.catalog.match(/:([^/:]+)$/)?.[1],
            availableOperators: [],
            packages: [],
          };
          next.mirror.operators.push(entry);
        } else {
          skipped.push(`catalog ${path.catalog} not found`);
          continue;
        }
      }
      const pkg = entry.packages.find(p => p.name === path.package);
      if (kind === 'add-operator' && suggestion.proposedChannels) {
        if (pkg) {
          skipped.push(`${path.package} already present in ${path.catalog}`);
        } else {
          entry.packages.push({
            name: path.package,
            channels: suggestion.proposedChannels.map(ch => ({
              name: ch.name,
              minVersion: ch.minVersion,
            })),
          });
          applied++;
        }
      } else if (
        kind === 'reset-unused-operator' &&
        suggestion.proposedChannels &&
        pkg
      ) {
        pkg.channels = suggestion.proposedChannels.map(ch => ({
          name: ch.name,
          minVersion: ch.minVersion,
        }));
        applied++;
      } else {
        skipped.push(
          `unsupported or stale operator-level suggestion on ${path.package}`,
        );
      }
      continue;
    }

    // operator-channel paths
    const pkg = findPackage(next, path.catalog, path.package);
    if (!pkg) {
      skipped.push(`${path.package} not found in ${path.catalog}`);
      continue;
    }

    const channel = pkg.channels.find(ch => ch.name === path.channel);
    switch (kind) {
      case 'add-channel':
        if (channel) {
          skipped.push(`${path.package}/${path.channel} already present`);
        } else {
          pkg.channels.push({
            name: path.channel,
            minVersion: suggestion.proposed ?? '',
          });
          applied++;
        }
        break;
      case 'remove-channel':
        if (!channel) {
          skipped.push(`${path.package}/${path.channel} not found`);
        } else if (pkg.channels.length <= 1) {
          skipped.push(
            `${path.package}/${path.channel}: removal would leave the package ` +
              'without channels — reject it or use a reset instead',
          );
        } else {
          pkg.channels = pkg.channels.filter(ch => ch.name !== path.channel);
          applied++;
        }
        break;
      default:
        if (channel && suggestion.proposed) {
          channel.minVersion = suggestion.proposed;
          applied++;
        } else {
          skipped.push(`${path.package}/${path.channel} not found`);
        }
    }
  }

  return { config: next, applied, skipped };
}
