import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const catalogDataDest = path.join(projectRoot, 'catalog-data');
const catalogDataFixture = path.join(projectRoot, 'tests/fixtures/catalog-data');

async function globalSetup() {
  try {
    await fs.promises.access(path.join(catalogDataDest, 'catalog-index.json'));
  } catch {
    await fs.promises.cp(catalogDataFixture, catalogDataDest, { recursive: true, force: true });
  }
}

export default globalSetup;
