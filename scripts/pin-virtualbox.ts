/**
 * Refresh the VirtualBox pin from Oracle: LATEST-STABLE.TXT for the version, that version's
 * SHA256SUMS for the Windows installer's name and checksum. Rewrites the VIRTUALBOX block in
 * src/pins.ts. Run: bun scripts/pin-virtualbox.ts [--dry-run]
 */
const BASE = "https://download.virtualbox.org/virtualbox";
const version = (await (await fetch(`${BASE}/LATEST-STABLE.TXT`)).text()).trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected LATEST-STABLE.TXT: ${version}`);
const sums = await (await fetch(`${BASE}/${version}/SHA256SUMS`)).text();
const line = sums.split("\n").find((l) => /\*?VirtualBox-[\d.]+-\d+-Win\.exe$/.test(l.trim()));
if (!line) throw new Error("no Windows installer in SHA256SUMS");
const [sha256, rawName] = line.trim().split(/\s+/);
const file = rawName.replace(/^\*/, "");
const build = file.match(/-(\d+)-Win\.exe$/)![1];
const block = `export const VIRTUALBOX: Pin = {
  version: "${version}",
  build: "${build}",
  file: "${file}",
  url: "${BASE}/${version}/${file}",
  sha256: "${sha256}",
  pinnedAt: "${new Date().toISOString().slice(0, 10)}",
};`;
const path = new URL("../src/pins.ts", import.meta.url);
const src = await Bun.file(path).text();
const next = src.replace(/export const VIRTUALBOX: Pin = \{[\s\S]*?\n\};/, block);
console.log(`VirtualBox ${version} (${file}) sha256 ${sha256}`);
if (!process.argv.includes("--dry-run")) await Bun.write(path, next);
