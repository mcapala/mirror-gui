/// <reference types="node" />

import { describe, it } from 'vitest';
import { access } from 'fs/promises';
import path from 'path';
import process from 'process';

const catalogDataDir = path.join(process.cwd(), 'catalog-data');

describe('committed catalog metadata integrity', () => {
  it('skipped: catalog data is now generated at build time, not committed', async () => {
    try {
      await access(path.join(catalogDataDir, 'catalog-index.json'));
    } catch {
      // No catalog data present -- expected when data is generated at build time
      return;
    }
  });
});
