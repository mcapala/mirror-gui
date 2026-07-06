import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ensureCatalogFixture } from '../helpers/catalogDataFixture.js';

const TLS_DIR = path.resolve('tests/fixtures/tls');

function ensureTlsFixture(): void {
  const key = path.join(TLS_DIR, 'server.key');
  const crt = path.join(TLS_DIR, 'server.crt');
  if (fs.existsSync(key) && fs.existsSync(crt)) {
    return;
  }
  fs.mkdirSync(TLS_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${key}" -out "${crt}" ` +
      `-days 30 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"`,
    { stdio: 'pipe' },
  );
}

async function globalSetup() {
  ensureTlsFixture();
  await ensureCatalogFixture();
}

export default globalSetup;
