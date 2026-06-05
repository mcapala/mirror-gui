import { ensureCatalogFixture } from '../../helpers/catalogDataFixture.js';

export default async function globalSetup() {
  await ensureCatalogFixture();
}
