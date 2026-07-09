import YAML from 'yaml';
import { diffLines, type Change } from 'diff';
import { buildCleanConfig } from '../cleanConfig';
import type { ImageSetConfig } from '../MirrorConfig';

// Both sides use identical serialization options, so the diff only ever
// contains suggestion-caused lines — even where this output differs from the
// Preview tab's digest-resolved view.
function iscYaml(config: ImageSetConfig): string {
  return YAML.stringify(buildCleanConfig(config), { indent: 2 });
}

export function computeIscDiff(
  before: ImageSetConfig,
  after: ImageSetConfig,
): Change[] {
  return diffLines(iscYaml(before), iscYaml(after));
}

export function diffCounts(parts: Change[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count ?? 0;
    if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}
