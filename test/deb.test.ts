import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const { version } = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version: string };
const deb = join(root, "dist", `pimp-my-hacking-lab_${version}_amd64.deb`);
const sh = (argv: string[]) => { const p = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };

describe("Ubuntu package (F14)", () => {
  test("ISC-77 build:deb makes a .deb with the binary in /opt, a valid launcher with no terminal, and an icon", () => {
    // Packages the binary already in dist/ when there is one (compiling takes a while); builds it otherwise.
    const r = sh(["bun", "scripts/build-deb.ts", ...(existsSync(join(root, "dist", "peh-lab-setup")) ? ["--no-build"] : [])]);
    expect(r.code).toBe(0);
    expect(existsSync(deb)).toBe(true);
    expect(sh(["ar", "t", deb]).out.split("\n").filter(Boolean)).toEqual(["debian-binary", "control.tar.gz", "data.tar.gz"]);
    const files = sh(["bash", "-c", `ar p '${deb}' data.tar.gz | tar -tvzf -`]).out;
    expect(files).toMatch(/-rwxr-xr-x (root\/root|0\/0) .* \.\/opt\/pimp-my-hacking-lab\/peh-lab-setup/);
    expect(files).toContain("./usr/share/icons/hicolor/scalable/apps/pimp-my-hacking-lab.svg");
    const control = sh(["bash", "-c", `ar p '${deb}' control.tar.gz | tar -xzOf - ./control`]).out;
    expect(control).toContain(`Version: ${version}`);
    expect(control).toContain("Package: pimp-my-hacking-lab");
    expect(control).toMatch(/^Depends: .*pkexec/m);
    const desktop = sh(["bash", "-c", `ar p '${deb}' data.tar.gz | tar -xzOf - ./usr/share/applications/pimp-my-hacking-lab.desktop`]).out;
    expect(desktop).toContain("Terminal=false");
    expect(desktop).toContain("Exec=/opt/pimp-my-hacking-lab/peh-lab-setup");
    expect(desktop).toContain("Icon=pimp-my-hacking-lab");
    if (sh(["bash", "-c", "command -v desktop-file-validate"]).code === 0) {
      const d = mkdtempSync(join(tmpdir(), "desk-"));
      writeFileSync(join(d, "pimp-my-hacking-lab.desktop"), desktop);
      const v = sh(["desktop-file-validate", join(d, "pimp-my-hacking-lab.desktop")]);
      rmSync(d, { recursive: true, force: true });
      expect(v.code).toBe(0);
      expect(v.out + v.err).not.toMatch(/error|warning|hint/i);
    }
  }, 300_000);
});
