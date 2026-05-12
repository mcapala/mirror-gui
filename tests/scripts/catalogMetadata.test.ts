/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function pyEval(expression: string): Promise<string> {
  const code = `
import sys
sys.path.insert(0, '.')
from scripts.catalog_metadata import compare_versions, sort_versions, version_range
print(${expression})
`.trim();

  const { stdout } = await execFileAsync('python3', ['-c', code]);
  return stdout.trim();
}

describe('catalog_metadata.py compare_versions', () => {
  it('compares simple semver correctly', async () => {
    expect(await pyEval('compare_versions("1.0.0", "2.0.0")')).toBe('-1');
    expect(await pyEval('compare_versions("2.0.0", "1.0.0")')).toBe('1');
    expect(await pyEval('compare_versions("1.0.0", "1.0.0")')).toBe('0');
    expect(await pyEval('compare_versions("1.0.0", "1.0.1")')).toBe('-1');
    expect(await pyEval('compare_versions("1.2.0", "1.10.0")')).toBe('-1');
  });

  it('compares numeric suffixes numerically, not lexicographically', async () => {
    expect(await pyEval('compare_versions("2.9.3-7", "2.9.3-17")')).toBe('-1');
    expect(await pyEval('compare_versions("2.9.3-17", "2.9.3-7")')).toBe('1');
    expect(await pyEval('compare_versions("7.13.5-9", "7.13.5-22")')).toBe('-1');
    expect(await pyEval('compare_versions("7.13.5-22", "7.13.5-9")')).toBe('1');
  });

  it('treats version without suffix as less than with suffix', async () => {
    expect(await pyEval('compare_versions("1.0.0", "1.0.0-1")')).toBe('-1');
    expect(await pyEval('compare_versions("1.0.0-1", "1.0.0")')).toBe('1');
  });

  it('handles equal suffixes', async () => {
    expect(await pyEval('compare_versions("2.9.3-7", "2.9.3-7")')).toBe('0');
    expect(await pyEval('compare_versions("7.13.5-22", "7.13.5-22")')).toBe('0');
  });
});

describe('catalog_metadata.py sort_versions', () => {
  it('sorts versions with numeric suffixes correctly', async () => {
    const result = await pyEval(
      'sort_versions(["2.9.3-7", "2.9.3-17", "2.9.3-12", "2.9.3-14", "2.9.3-16"])'
    );
    expect(result).toBe("['2.9.3-7', '2.9.3-12', '2.9.3-14', '2.9.3-16', '2.9.3-17']");
  });

  it('sorts mixed versions correctly', async () => {
    const result = await pyEval(
      'sort_versions(["7.13.5-2", "7.13.5-9", "7.13.5-20", "7.13.5-21", "7.13.5-22"])'
    );
    expect(result).toBe("['7.13.5-2', '7.13.5-9', '7.13.5-20', '7.13.5-21', '7.13.5-22']");
  });
});

describe('catalog_metadata.py version_range', () => {
  it('returns correct min/max after sorting', async () => {
    const result = await pyEval(
      'version_range(sort_versions(["2.9.3-7", "2.9.3-17", "2.9.3-12"]))'
    );
    expect(result).toBe("{'minVersion': '2.9.3-7', 'maxVersion': '2.9.3-17'}");
  });

  it('returns correct max for businessautomation-operator versions', async () => {
    const result = await pyEval(
      'version_range(sort_versions(["1.2.0", "7.13.5-9", "7.13.5-20", "7.13.5-21", "7.13.5-22"]))'
    );
    expect(result).toBe("{'minVersion': '1.2.0', 'maxVersion': '7.13.5-22'}");
  });
});
