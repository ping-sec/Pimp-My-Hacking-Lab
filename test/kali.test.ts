import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KALI, SEVENZR } from "../src/pins";
import { kaliDownloadStep, kaliImportStep, KALI_VM_NAME } from "../src/kali";
import type { Sys } from "../src/virtualbox";
import type { StepFailure } from "../src/steps";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ARCHIVE = bytes("fake kali 7z"), SEVEN = bytes("fake 7zr.exe");
const kaliPin = { ...KALI, sha256: sha(ARCHIVE) };
const sevenPin = { ...SEVENZR, sha256: sha(SEVEN) };

function fakeSys(o: { archive?: Uint8Array; extractCode?: number; vms?: string[]; ramGb?: number; running?: boolean; modifyErr?: string; noNetDriver?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "kali-")); dirs.push(cacheDir);
  const calls: string[][] = [];
  const vms = new Set(o.vms ?? []);
  const fetched: string[] = [];
  const sys: Sys & { ramGb: number } = {
    platform: "win32", env: {}, cacheDir, ramGb: o.ramGb ?? 16,
    vboxManagePath: () => "C:\\VB\\VBoxManage.exe",
    async exec(argv) {
      calls.push(argv);
      if (argv[0].endsWith("7zr.exe")) {
        if ((o.extractCode ?? 0) !== 0) return { code: o.extractCode!, stdout: "", stderr: "ERROR: There is not enough space on the disk" };
        const out = argv.find((a) => a.startsWith("-o"))!.slice(2);
        const d = join(out, `kali-linux-${KALI.version}-virtualbox-amd64`); mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `kali-linux-${KALI.version}-virtualbox-amd64.vbox`), "<vbox/>");
        return { code: 0, stdout: "Everything is Ok", stderr: "" };
      }
      const [, cmd, ...rest] = argv;
      if (cmd === "list" && rest[0] === "vms") return { code: 0, stdout: [...vms].map((n) => `"${n}" {uuid}`).join("\n"), stderr: "" };
      if (cmd === "registervm") { vms.add(`kali-linux-${KALI.version}-virtualbox-amd64`); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "modifyvm" && rest.includes("--name")) { vms.delete(rest[0]); vms.add(rest[rest.indexOf("--name") + 1]); }
      if (cmd === "showvminfo") return { code: 0, stdout: `VMState="${o.running ? "running" : "poweroff"}"`, stderr: "" };
      if (cmd === "modifyvm" && o.modifyErr && rest.includes("--memory")) return { code: 1, stdout: "", stderr: o.modifyErr };
      if (cmd === "list" && rest[0] === "hostonlyifs") return { code: 0, stdout: o.noNetDriver ? "" : "Name: VirtualBox Host-Only Ethernet Adapter\nIPAddress: 192.168.56.1\n", stderr: "" };
      if (cmd === "hostonlyif" && rest[0] === "create" && o.noNetDriver) return { code: 1, stdout: "0%...", stderr: "VBoxManage.exe: error: Failed to create the host-only adapter\nVBoxManage.exe: error: Could not find Host Interface Networking driver! Please reinstall" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetch: (async (url: string) => { fetched.push(String(url)); const b = String(url).endsWith("7zr.exe") ? SEVEN : (o.archive ?? ARCHIVE); return new Response(b, { headers: { "content-length": String(b.length) } }); }) as unknown as typeof fetch,
  };
  return { sys, calls, fetched, vms };
}
async function run(step: { run: (c: { signal: AbortSignal; progress: (f: number) => void }) => Promise<void> }) {
  const fr: number[] = [];
  try { await step.run({ signal: new AbortController().signal, progress: (f) => fr.push(f) }); return { ok: true as const, fr }; }
  catch (e) { return { ok: false as const, fr, failure: (e as { failure?: StepFailure }).failure }; }
}

describe("Kali download + import", () => {
  test("ISC-20 Kali and 7zr are pinned with SHA-256", () => {
    expect(KALI.url).toBe(`https://cdimage.kali.org/kali-${KALI.version}/${KALI.file}`);
    expect(KALI.file).toBe(`kali-linux-${KALI.version}-virtualbox-amd64.7z`);
    expect(KALI.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SEVENZR.url).toBe("https://www.7-zip.org/a/7zr.exe");
    expect(SEVENZR.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  test("ISC-21 verifies the download, rejects a damaged one, and reuses a verified one", async () => {
    const good = fakeSys();
    expect((await run(kaliDownloadStep(good.sys, kaliPin, sevenPin))).ok).toBe(true);
    const again = await run(kaliDownloadStep(good.sys, kaliPin, sevenPin));
    expect(again.ok).toBe(true);
    expect(good.fetched.filter((u) => u.endsWith(".7z")).length).toBe(1);
    const bad = fakeSys({ archive: bytes("tampered") });
    const r = await run(kaliDownloadStep(bad.sys, kaliPin, sevenPin));
    expect(r.failure!.code).toBe("KALI-SHA");
    expect(r.failure!.todo).toMatch(/Try again/);
    expect(existsSync(join(bad.sys.cacheDir, kaliPin.file))).toBe(false);
  });
  test("ISC-22 extracts with the pinned 7zr and fails plainly when extraction fails", async () => {
    const ok = fakeSys();
    await run(kaliDownloadStep(ok.sys, kaliPin, sevenPin));
    expect(ok.calls.some((c) => c[0].endsWith("7zr.exe") && c[1] === "x")).toBe(true);
    const full = fakeSys({ extractCode: 2 });
    const r = await run(kaliDownloadStep(full.sys, kaliPin, sevenPin));
    expect(r.failure!.code).toBe("KALI-EXTRACT");
    expect(r.failure!.todo).toMatch(/space/i);
  });
  test("ISC-23 imports as Kali (PEH) with memory sized to the PC; leaves an existing VM alone", async () => {
    const f = fakeSys({ ramGb: 8 });
    await run(kaliDownloadStep(f.sys, kaliPin, sevenPin));
    expect((await run(kaliImportStep(f.sys, kaliPin))).ok).toBe(true);
    expect(f.vms.has(KALI_VM_NAME)).toBe(true);
    const mod = f.calls.filter((c) => c[1] === "modifyvm").map((c) => c.join(" ")).join(" ");
    expect(mod).toContain("--memory 2048");
    expect(mod).toContain("--cpus 2");
    const exists = fakeSys({ vms: [KALI_VM_NAME] });
    expect((await run(kaliImportStep(exists.sys, kaliPin))).ok).toBe(true);
    expect(exists.calls.some((c) => c[1] === "registervm")).toBe(false);
  });
  test("ISC-44 a half-done import is finished; a running Kali is left as is", async () => {
    const half = fakeSys({ vms: [KALI_VM_NAME], ramGb: 64 });
    expect((await run(kaliImportStep(half.sys, kaliPin))).ok).toBe(true);
    expect(half.calls.some((c) => c[1] === "registervm")).toBe(false);
    const mod = half.calls.filter((c) => c[1] === "modifyvm").map((c) => c.join(" ")).join(" ");
    expect(mod).toContain("--memory 4096");
    expect(mod).toContain("--nic1 nat");
    expect(mod).toContain("--nic2 hostonly");
    expect(mod).not.toMatch(/bridged/);
    const live = fakeSys({ vms: [KALI_VM_NAME], running: true });
    expect((await run(kaliImportStep(live.sys, kaliPin))).ok).toBe(true);
    expect(live.calls.some((c) => c[1] === "modifyvm")).toBe(false);
  });
  test("ISC-45 an import failure keeps VirtualBox's own error text", async () => {
    const f = fakeSys({ vms: [KALI_VM_NAME], modifyErr: "VBoxManage.exe: error: The machine is locked for a session" });
    const r = await run(kaliImportStep(f.sys, kaliPin));
    expect(r.ok).toBe(false);
    expect(r.failure?.detail).toContain("locked for a session");
  });
  test("ISC-24 two adapters, NAT and host-only, never bridged", async () => {
    const f = fakeSys();
    await run(kaliDownloadStep(f.sys, kaliPin, sevenPin));
    await run(kaliImportStep(f.sys, kaliPin));
    const mod = f.calls.filter((c) => c[1] === "modifyvm").map((c) => c.join(" ")).join(" ");
    expect(mod).toContain("--nic1 nat");
    expect(mod).toContain("--nic2 hostonly");
    expect(mod).toContain("--hostonlyadapter2 VirtualBox Host-Only Ethernet Adapter");
    expect(mod).not.toMatch(/bridged/);
  });
});

describe("missing network driver", () => {
  test("ISC-62 KALI-NET for a missing host-only driver names the VirtualBox step to redo, keeping VirtualBox's error", async () => {
    const { applyKaliSettings } = await import("../src/kali");
    const { sys } = fakeSys({ noNetDriver: true });
    const e = await applyKaliSettings(sys).catch((x) => x);
    expect(e.failure.code).toBe("KALI-NET");
    expect(e.failure.redo).toBe("virtualbox");
    expect(e.failure.detail).toContain("Host Interface Networking driver");
  });
});
