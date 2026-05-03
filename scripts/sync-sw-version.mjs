// v11.24.3: sync the service worker's SW_VERSION constant from
// lib/version.ts so every release ships a byte-different sw.js.
//
// Browsers detect a new service worker by byte-comparing the
// registered file against the cached copy. If only TypeScript code
// changes between releases but public/sw.js is identical, no
// `updatefound` event fires and the update toast never surfaces.
// Wiring this script as `prebuild` removes the manual bump step.
//
// Idempotent: when sw.js already matches the current APP_VERSION the
// script logs and exits without rewriting (so prebuild stays cheap and
// the file's mtime isn't churned in dev).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root        = process.cwd();
const versionFile = resolve(root, 'lib/version.ts');
const swFile      = resolve(root, 'public/sw.js');

const versionSrc = readFileSync(versionFile, 'utf8');
const match      = versionSrc.match(/APP_VERSION\s*=\s*'([^']+)'/);
if (!match) {
  console.error('[sync-sw] could not parse APP_VERSION from lib/version.ts');
  process.exit(1);
}
const appVersion = match[1];

const swSrc = readFileSync(swFile, 'utf8');
const next  = swSrc.replace(
  /const\s+SW_VERSION\s*=\s*'gcppro-v[^']*'/,
  `const SW_VERSION  = 'gcppro-v${appVersion}'`,
);

if (next === swSrc) {
  console.log(`[sync-sw] sw.js already on v${appVersion}`);
} else {
  writeFileSync(swFile, next, 'utf8');
  console.log(`[sync-sw] sw.js bumped to v${appVersion}`);
}
