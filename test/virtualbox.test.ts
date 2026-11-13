import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIRTUALBOX } from "../src/pins";
import { virtualboxStep, type Sys } from "../src/virtualbox";
import type { StepFailure, StepQuestion } from "../src/steps";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FAKE_EXE = new TextEncoder().encode("fake VirtualBox installer bytes");
const FAKE_SHA = createHash("sha256").update(FAKE_EXE).digest("hex");
const pin = { ...VIRTUALBOX, sha256: FAKE_SHA };

/** A fake Windows machine: records every command, answers VBoxManage from `installed`. */
function fakeSys(o: { installed?: string | null; installerExit?: number; installerStderr?: string; afterInstall?: string | null; body?: Uint8Array; running?: string[]; extpack?: boolean; driver?: "ok" | "files" | "store"; pnputilWorks?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "vbox-")); dirs.push(cacheDir);
  const calls: string[][] = [];
  let installed = o.installed ?? null;
  let driver = o.driver ?? "ok"; // what is missing: nothing, the files, or the driver-store entry
  const sys: Sys = {
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    cacheDir,
    vboxManagePath: () => (installed ? "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe" : null),
    hostOnlyDriver: () => driver,

    async exec(argv) {
      calls.push(argv);
      if (argv[0].endsWith("VBoxManage.exe") && argv[1] === "list" && argv[2] === "runningvms") return { code: 0, stdout: (o.running ?? []).map((n, i) => `"${n}" {0000000${i}-0000-0000-0000-000000000000}`).join("\n"), stderr: "" };
      if (argv[0].endsWith("VBoxManage.exe") && argv[1] === "list" && argv[2] === "extpacks") return { code: 0, stdout: o.extpack ? "Extension Packs: 1\nPack no. 0:   Oracle VirtualBox Extension Pack\nVersion:      7.0.14\n" : "Extension Packs: 0\n", stderr: "" };
      if (argv[0].endsWith("VBoxManage.exe")) return installed ? { code: 0, stdout: `${installed}r175245\n`, stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
      if (argv[0] === "powershell" && argv.join(" ").includes("pnputil")) { if (o.pnputilWorks !== false) driver = "ok"; return { code: 0, stdout: o.pnputilWorks === false ? "5\n" : "0\n", stderr: "" }; }
      if (argv[0] === "powershell") {
        const code = o.installerExit ?? 0;
        if (code === 0 || code === 3010) { const fresh = !installed; installed = o.afterInstall === undefined ? pin.version : o.afterInstall; driver = fresh ? "ok" : driver === "ok" ? "ok" : "store"; }
        return { code: code === 3010 || code === 0 ? 0 : 1, stdout: `${code}\n`, stderr: o.installerStderr ?? "" };
      }
      return { code: 127, stdout: "", stderr: "unknown" };
    },
    fetch: (async () => new Response(o.body ?? FAKE_EXE, { headers: { "content-length": String((o.body ?? FAKE_EXE).length) } })) as unknown as typeof fetch,
  };
  return { sys, calls };
}
async function run(sys: Sys, confirmed = false) {
  const fractions: number[] = [];
  try { await virtualboxStep(sys, pin).run({ signal: new AbortController().signal, progress: (f) => fractions.push(f), confirmed }); return { ok: true as const, fractions }; }
  catch (e) { return { ok: false as const, fractions, failure: (e as { failure?: StepFailure }).failure, question: (e as { question?: StepQuestion }).question }; }
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
  test("ISC-46 an older VirtualBox pauses for a yes before anything is downloaded or installed", async () => {
    const { sys, calls } = fakeSys({ installed: "7.0.14" });
    const r = await run(sys);
    expect(r.ok).toBe(false);
    expect(r.question?.code).toBe("VBOX-UPGRADE");
    expect(r.question?.what).toContain("7.0.14");
    expect(r.question?.what).toContain(pin.version);
    expect(r.question?.todo).toMatch(/kept/);
    expect(r.question?.confirm).toBe("Upgrade VirtualBox");
    expect(calls.some((c) => c[0] === "powershell")).toBe(false);
    expect(existsSync(join(sys.cacheDir, pin.file))).toBe(false);
    const yes = await run(sys, true);
    expect(yes.ok).toBe(true);
  });
  test("ISC-47 running VMs block the upgrade even after a yes, and are named", async () => {
    const { sys, calls } = fakeSys({ installed: "7.1.4", running: ["Windows Server 2022", "Kioptrix"] });
    for (const confirmed of [false, true]) {
      const r = await run(sys, confirmed);
      expect(r.question?.code).toBe("VBOX-RUNNING");
      expect(r.question?.what).toContain("Windows Server 2022");
      expect(r.question?.what).toContain("Kioptrix");
      expect(r.question?.todo).toMatch(/shut/i);
    }
    expect(calls.some((c) => c[0] === "powershell")).toBe(false);
  });
  test("ISC-48 an installed Extension Pack is called out", async () => {
    const withPack = await run(fakeSys({ installed: "7.0.14", extpack: true }).sys);
    expect(withPack.question?.todo).toMatch(/Extension Pack/);
    const without = await run(fakeSys({ installed: "7.0.14" }).sys);
    expect(without.question?.todo).not.toMatch(/Extension Pack/);
  });
});

describe("VBoxManage lookup", () => {
  const { realSys } = require("../src/virtualbox") as typeof import("../src/virtualbox");
  test("ISC-58 found from the registry InstallDir, kept once found, and every searched folder is listed", () => {
    const d = mkdtempSync(join(tmpdir(), "vbm-")); dirs.push(d);
    let regCalls = 0;
    const sys = realSys(d, { env: {}, regInstallDir: () => { regCalls++; return d; } });
    expect(sys.vboxManagePath()).toBeNull();
    expect(sys.vboxSearched!()).toContain(d);
    expect(sys.vboxSearched!().some((p) => p.includes("Oracle"))).toBe(true);
    Bun.write(join(d, "VBoxManage.exe"), "x");
    return Bun.sleep(5).then(() => {
      expect(sys.vboxManagePath()).toBe(join(d, "VBoxManage.exe"));
      const n = regCalls;
      rmSync(join(d, "VBoxManage.exe"));
      expect(sys.vboxManagePath()).toBe(join(d, "VBoxManage.exe")); // kept for the run
      expect(regCalls).toBe(n);
    });
  });
  test("ISC-58 a NOVBOX failure carries the searched folders as detail", async () => {
    const { pimpmykaliStep } = await import("../src/pimpmykali");
    const { PIMPMYKALI } = await import("../src/pins");
    const sys: Sys = { platform: "win32", env: {}, cacheDir: mkdtempSync(join(tmpdir(), "vbm-")), vboxManagePath: () => null, vboxSearched: () => ["D:\\VB", "C:\\Program Files\\Oracle\\VirtualBox"], exec: async () => ({ code: 0, stdout: "", stderr: "" }), fetch };
    dirs.push(sys.cacheDir);
    const e = await pimpmykaliStep(sys, PIMPMYKALI).run({ progress: () => {}, signal: new AbortController().signal } as never).catch((x) => x);
    expect(e.failure.code).toBe("PMK-NOVBOX");
    expect(e.failure.detail).toContain("D:\\VB");
  });
});

describe("host-only network driver", () => {
  const ps = (calls: string[][], what: string) => calls.filter((c) => c[0] === "powershell" && c.join(" ").includes(what)).length;
  test("ISC-62 the install names both network child features, host-only included", async () => {
    const { installerCommand } = await import("../src/virtualbox");
    expect(installerCommand("C:\\x.exe").join(" ")).toContain("ADDLOCAL=VBoxApplication,VBoxUSB,VBoxNetwork,VBoxNetworkFlt,VBoxNetworkAdp");
  });
  test("ISC-62 the driver is registered with pnputil from VirtualBox's netadp6 folder, elevated, its output kept", async () => {
    const { pnputilCommand } = await import("../src/virtualbox");
    const cmd = pnputilCommand("C:\\Program Files\\Oracle\\VirtualBox", "C:\\Users\\s\\AppData\\Local\\PEHLab\\downloads\\pnputil.txt").join(" ");
    expect(cmd).toContain("-Verb RunAs");
    expect(cmd).toContain('pnputil /add-driver "C:\\Program Files\\Oracle\\VirtualBox\\drivers\\network\\netadp6\\VBoxNetAdp6.inf" /install > "C:\\Users\\s\\AppData\\Local\\PEHLab\\downloads\\pnputil.txt" 2>&1');
  });
  test("ISC-62 VBOX-NET says which check failed and what pnputil said", async () => {
    const { sys } = fakeSys({ installed: VIRTUALBOX.version, driver: "store", pnputilWorks: false });
    const r = await run(sys);
    expect(r.failure?.code).toBe("VBOX-NET");
    expect(r.failure?.detail).toContain("Driver check: store");
    expect(r.failure?.detail).toContain("pnputil exit 5");
  });
  test("ISC-62 driver files present but not registered (seen on a real PC): pnputil only, no installer", async () => {
    const { sys, calls } = fakeSys({ installed: VIRTUALBOX.version, driver: "store" });
    expect((await run(sys)).ok).toBe(true);
    expect(ps(calls, "pnputil")).toBe(1);
    expect(ps(calls, "--msiparams")).toBe(0);
  });
  test("ISC-62 driver files missing: the installer adds them, then pnputil registers the driver", async () => {
    const { sys, calls } = fakeSys({ installed: VIRTUALBOX.version, driver: "files" });
    expect((await run(sys)).ok).toBe(true);
    expect(ps(calls, "--msiparams")).toBe(1);
    expect(ps(calls, "pnputil")).toBe(1);
  });
  test("ISC-62 a fresh install needs no pnputil", async () => {
    const { sys, calls } = fakeSys({ installed: null });
    expect((await run(sys)).ok).toBe(true);
    expect(ps(calls, "pnputil")).toBe(0);
  });
  test("ISC-62 still not registered after pnputil fails VBOX-NET", async () => {
    const { sys } = fakeSys({ installed: VIRTUALBOX.version, driver: "store", pnputilWorks: false });
    expect((await run(sys)).failure?.code).toBe("VBOX-NET");
  });
  test("ISC-62 a current VirtualBox with the driver is left alone", async () => {
    const { sys, calls } = fakeSys({ installed: VIRTUALBOX.version });
    expect((await run(sys)).ok).toBe(true);
    expect(calls.some((c) => c[0] === "powershell")).toBe(false);
  });
});

describe("VirtualBox evidence", () => {
  test("ISC-55 VBOX-INSTALL keeps the installer's own output for the help bundle", async () => {
    const { sys } = fakeSys({ installed: null, installerExit: 1603, installerStderr: "MSI error 1603: fatal error during installation" });
    const r = await run(sys);
    expect(r.failure?.code).toBe("VBOX-INSTALL");
    expect(r.failure?.detail).toContain("fatal error during installation");
  });
});
