import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIRTUALBOX } from "../src/pins";
import { virtualboxStep, type Sys } from "../src/virtualbox";
import type { StepFailure } from "../src/steps";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FAKE_EXE = new TextEncoder().encode("fake VirtualBox installer bytes");
const FAKE_SHA = createHash("sha256").update(FAKE_EXE).digest("hex");
const pin = { ...VIRTUALBOX, sha256: FAKE_SHA };

/** A fake Windows machine: records every command, answers VBoxManage from `installed`. */
function fakeSys(o: { installed?: string | null; installerExit?: number; installerStderr?: string; afterInstall?: string | null; body?: Uint8Array } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "vbox-")); dirs.push(cacheDir);
  const calls: string[][] = [];
  let installed = o.installed ?? null;
  const sys: Sys = {
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    cacheDir,
    vboxManagePath: () => (installed ? "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe" : null),
    async exec(argv) {
      calls.push(argv);
      if (argv[0].endsWith("VBoxManage.exe")) return installed ? { code: 0, stdout: `${installed}r175245\n`, stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
      if (argv[0] === "powershell") {
        const code = o.installerExit ?? 0;
        if (code === 0 || code === 3010) installed = o.afterInstall === undefined ? pin.version : o.afterInstall;
        return { code: code === 3010 || code === 0 ? 0 : 1, stdout: `${code}\n`, stderr: o.installerStderr ?? "" };
      }
      return { code: 127, stdout: "", stderr: "unknown" };
    },
    fetch: (async () => new Response(o.body ?? FAKE_EXE, { headers: { "content-length": String((o.body ?? FAKE_EXE).length) } })) as unknown as typeof fetch,
  };
  return { sys, calls };
}
async function run(sys: Sys) {
  const fractions: number[] = [];
  try { await virtualboxStep(sys, pin).run({ signal: new AbortController().signal, progress: (f) => fractions.push(f) }); return { ok: true as const, fractions }; }
  catch (e) { return { ok: false as const, fractions, failure: (e as { failure?: StepFailure }).failure }; }
}

describe("VirtualBox step", () => {
  test("ISC-13 the pin names an exact version, its Windows installer, and a SHA-256", () => {
    expect(VIRTUALBOX.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VIRTUALBOX.url).toBe(`https://download.virtualbox.org/virtualbox/${VIRTUALBOX.version}/${VIRTUALBOX.file}`);
    expect(VIRTUALBOX.file).toMatch(new RegExp(`^VirtualBox-${VIRTUALBOX.version.replaceAll(".", "\\.")}-\\d+-Win\\.exe$`));
    expect(VIRTUALBOX.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(new URL("../scripts/pin-virtualbox.ts", import.meta.url))).toBe(true);
  });
  test("ISC-14 skips download and install when the pinned version or newer is present", async () => {
    const { sys, calls } = fakeSys({ installed: "7.9.0" });
    const r = await run(sys);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[0] === "powershell")).toBe(false);
    expect(r.fractions.at(-1)).toBe(1);
  });
  test("ISC-15 download reports progress and a checksum mismatch deletes the file with a plain failure", async () => {
    const good = fakeSys();
    const ok = await run(good.sys);
    expect(ok.ok).toBe(true);
    expect(ok.fractions.length).toBeGreaterThan(2);
    const bad = fakeSys({ body: new TextEncoder().encode("tampered") });
    const r = await run(bad.sys);
    expect(r.ok).toBe(false);
    expect(r.failure!.code).toBe("VBOX-SHA");
    expect(r.failure!.todo).toMatch(/Try again/);
    expect(existsSync(join(bad.sys.cacheDir, pin.file))).toBe(false);
    expect(bad.calls.some((c) => c[0] === "powershell")).toBe(false);
  });
  test("ISC-16 installs elevated, silently, without Python, without auto-start; 3010 is success", async () => {
    const { sys, calls } = fakeSys({ installerExit: 3010 });
    const r = await run(sys);
    expect(r.ok).toBe(true);
    const ps = calls.find((c) => c[0] === "powershell")!.join(" ");
    expect(ps).toContain("-Verb RunAs");
    expect(ps).toContain("-Wait");
    expect(ps).toContain("--silent");
    expect(ps).toContain("ADDLOCAL=VBoxApplication,VBoxUSB,VBoxNetwork");
    expect(ps).not.toContain("VBoxPython");
    expect(ps).toContain("VBOX_START=0");
  });
  test("ISC-17 a declined permission prompt asks the student to click Yes", async () => {
    const { sys } = fakeSys({ installerExit: 1223, installerStderr: "Start-Process : This command cannot be run due to the error: The operation was canceled by the user." });
    const r = await run(sys);
    expect(r.ok).toBe(false);
    expect(r.failure!.code).toBe("VBOX-UAC");
    expect(r.failure!.todo).toMatch(/Yes/);
  });
  test("ISC-18 the install must leave VBoxManage reporting the pinned version", async () => {
    const { sys } = fakeSys({ afterInstall: null });
    const r = await run(sys);
    expect(r.ok).toBe(false);
    expect(r.failure!.code).toBe("VBOX-VERIFY");
  });
  test("refuses to run anywhere but Windows, in plain words", async () => {
    const { sys } = fakeSys(); sys.platform = "linux";
    const r = await run(sys);
    expect(r.failure!.code).toBe("VBOX-OS");
  });
});
