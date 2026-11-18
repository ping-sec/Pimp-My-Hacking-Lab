/**
 * Builds the Ubuntu package (ISC-77): dist/pimp-my-hacking-lab_<version>_amd64.deb.
 * A student double-clicks it, Ubuntu's App Center installs it, and "Pimp My Hacking Lab" is in the app grid.
 * Made with tar and ar only, so it builds on any Linux box (no dpkg-deb needed).
 *
 *   bun scripts/build-deb.ts            # compiles the binary first
 *   bun scripts/build-deb.ts --no-build # packages dist/peh-lab-setup as it is
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const { version } = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version: string };
export const PKG = "pimp-my-hacking-lab";
const out = join(root, "dist", `${PKG}_${version}_amd64.deb`);
const bin = join(root, "dist", "peh-lab-setup");

function run(argv: string[], cwd = root) {
  const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${p.stderr.toString()}`);
}

if (!process.argv.includes("--no-build")) {
  // Baseline x64 runs on CPUs without AVX2, which many student laptops are.
  run(["bun", "build", "src/server.ts", "--compile", "--minify", "--target=bun-linux-x64-baseline", "--outfile", bin]);
}
if (!existsSync(bin)) throw new Error(`missing ${bin}; run without --no-build`);

const work = join(root, "dist", "deb-build");
rmSync(work, { recursive: true, force: true });
const data = join(work, "data"), control = join(work, "control");
for (const d of ["opt/pimp-my-hacking-lab", "usr/share/applications", "usr/share/icons/hicolor/scalable/apps"]) mkdirSync(join(data, d), { recursive: true });
mkdirSync(control, { recursive: true });

copyFileSync(bin, join(data, "opt/pimp-my-hacking-lab/peh-lab-setup"));
chmodSync(join(data, "opt/pimp-my-hacking-lab/peh-lab-setup"), 0o755);
copyFileSync(join(root, "ui", "icon.svg"), join(data, `usr/share/icons/hicolor/scalable/apps/${PKG}.svg`));
writeFileSync(join(data, `usr/share/applications/${PKG}.desktop`), [
  "[Desktop Entry]",
  "Type=Application",
  "Name=Pimp My Hacking Lab",
  "GenericName=Ethical hacking lab setup",
  "Comment=Sets up VirtualBox, Kali Linux and PimpMyKali for the Practical Ethical Hacking course",
  "Exec=/opt/pimp-my-hacking-lab/peh-lab-setup",
  `Icon=${PKG}`,
  "Terminal=false",
  "Categories=Education;",
  "Keywords=kali;virtualbox;hacking;lab;pentest;",
  "StartupNotify=false",
  "",
].join("\n"));

const kb = Math.ceil(statSync(bin).size / 1024) + 8;
writeFileSync(join(control, "control"), [
  `Package: ${PKG}`,
  `Version: ${version}`,
  "Architecture: amd64",
  "Maintainer: Ping-Sec <https://github.com/ping-sec/Pimp-My-Hacking-Lab>",
  `Installed-Size: ${kb}`,
  "Depends: xdg-utils, pkexec | policykit-1",
  "Recommends: mokutil",
  "Section: education",
  "Priority: optional",
  "Homepage: https://github.com/ping-sec/Pimp-My-Hacking-Lab",
  "Description: One-click lab setup for the Practical Ethical Hacking course",
  " Installs VirtualBox, imports the official Kali Linux VirtualBox image and runs",
  " PimpMyKali inside it, from one button in your browser. Kali gets NAT plus a",
  " private host-only lab network and is never bridged to your home network.",
  " Unofficial community tool; a nod to Dewalt, author of PimpMyKali.",
  "",
].join("\n"));

const tar = (dir: string, file: string) => run(["tar", "--owner=0", "--group=0", "--numeric-owner", "--sort=name", "-czf", file, "-C", dir, "."]);
tar(control, join(work, "control.tar.gz"));
tar(data, join(work, "data.tar.gz"));
writeFileSync(join(work, "debian-binary"), "2.0\n");
rmSync(out, { force: true });
run(["ar", "rcD", out, "debian-binary", "control.tar.gz", "data.tar.gz"], work); // order is part of the format
rmSync(work, { recursive: true, force: true });
console.log(out);
