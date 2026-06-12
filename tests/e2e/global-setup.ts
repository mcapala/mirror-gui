import { ensureCatalogFixture } from '../helpers/catalogDataFixture.js';

async function globalSetup() {
  await ensureCatalogFixture();
}

export default globalSetup;
