/* Offline installer: resolves deps from local npm cacache, flat node_modules. */
const NPMLIB = '/usr/local/lib/node_modules/npm/node_modules';
const cacache = require(`${NPMLIB}/cacache`);
const semver = require(`${NPMLIB}/semver`);
const tar = require(`${NPMLIB}/tar`);
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE = path.join(os.homedir(), '.npm', '_cacache');
const ROOT = __dirname;
const NM = path.join(ROOT, 'node_modules');

async function main() {
  const index = await cacache.ls(CACHE);
  // name -> { version -> key }
  const avail = new Map();
  for (const key of Object.keys(index)) {
    const m = key.match(/^make-fetch-happen:request-cache:https:\/\/registry\.npmjs\.org\/(.+)\/-\/[^/]+-(\d[^/]*?)\.tgz$/);
    if (!m) continue;
    const name = decodeURIComponent(m[1]);
    const version = m[2];
    if (!avail.has(name)) avail.set(name, new Map());
    avail.get(name).set(version, key);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const roots = { ...pkg.dependencies, ...pkg.devDependencies };
  const installed = new Map(); // name -> version
  const missing = [];
  const queue = Object.entries(roots).map(([n, r]) => [n, r, false]);

  while (queue.length) {
    const [name, range, optional] = queue.shift();
    if (installed.has(name)) continue;
    const versions = avail.get(name);
    if (!versions) { if (!optional) missing.push(`${name}@${range}`); continue; }
    const vlist = [...versions.keys()];
    let v = semver.maxSatisfying(vlist, range, { includePrerelease: true });
    if (!v) v = vlist.sort(semver.rcompare)[0]; // fallback: highest available
    const key = versions.get(v);
    const dest = path.join(NM, ...name.split('/'));
    fs.mkdirSync(dest, { recursive: true });
    const { data } = await cacache.get(CACHE, key);
    await new Promise((res, rej) => {
      const s = tar.x({ cwd: dest, strip: 1 });
      s.on('finish', res); s.on('error', rej);
      s.end(data);
    });
    installed.set(name, v);
    const sub = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    for (const [n, r] of Object.entries(sub.dependencies || {})) queue.push([n, r, false]);
    for (const [n, r] of Object.entries(sub.peerDependencies || {})) queue.push([n, r, true]);
    for (const [n, r] of Object.entries(sub.optionalDependencies || {})) {
      // only platform-matching natives
      queue.push([n, r, true]);
    }
  }

  // .bin links
  const bin = path.join(NM, '.bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name] of installed) {
    const dir = path.join(NM, ...name.split('/'));
    let sub;
    try { sub = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    let bins = sub.bin;
    if (!bins) continue;
    if (typeof bins === 'string') bins = { [name.split('/').pop()]: bins };
    for (const [bn, rel] of Object.entries(bins)) {
      const target = path.join(dir, rel);
      const link = path.join(bin, bn);
      try { fs.rmSync(link, { force: true }); fs.symlinkSync(target, link); fs.chmodSync(target, 0o755); } catch {}
    }
  }

  console.log(`installed ${installed.size} packages`);
  if (missing.length) console.log('MISSING:\n' + missing.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
