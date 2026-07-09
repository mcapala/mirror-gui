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

  // Additive suggestions first, removals last so a batched channel swap
  // never trips the "would leave the package without channels" guard on
  // the pre-add state.
  const ordered = [
    ...suggestions.filter(s => s.kind !== 'remove-channel'),
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
