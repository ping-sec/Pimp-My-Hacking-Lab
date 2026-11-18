import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelNeedsKvmOption, linuxVirtualboxStep, MOK_STEPS, parseMokTest, rootScript, type LinuxHost, type MokState } from "../src/linux";
import { VIRTUALBOX_NOBLE } from "../src/pins";
import { createApp, defaultConfig, pcCheck, type Config } from "../src/server";
import { stepInfo, STEP_INFO, type StepFailure, type StepQuestion } from "../src/steps";
import type { Sys } from "../src/virtualbox";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const DEB = new TextEncoder().encode("fake VirtualBox noble deb bytes");
const pin = { ...VIRTUALBOX_NOBLE, sha256: createHash("sha256").update(DEB).digest("hex") };

interface Box { installed: string | null; drv: boolean; mok: MokState; virtAtLoad: boolean | null; boot: string; resume: boolean | null }

/** A fake Ubuntu 24.04 PC: VBoxManage, pkexec and systemctl answer from `box`; the root script's effects are simulated. */
function fakeUbuntu(o: { installed?: string | null; drv?: boolean; sb?: boolean | null; mok?: MokState; kernel?: string; virtAtLoad?: boolean | null; pkexec?: number; aptFails?: boolean; drvAfterInstall?: boolean; kvmInUse?: boolean } = {}) {
  const cacheDir = tmp("lnx-");
  const calls: string[][] = [];
  const scripts: string[] = [];
  const box: Box = { installed: o.installed ?? null, drv: o.drv ?? false, mok: o.mok ?? "no-key", virtAtLoad: o.virtAtLoad ?? null, boot: "boot-A", resume: null };
  const sys: Sys = {
    platform: "linux",
    env: {},
    cacheDir,
    vboxManagePath: () => (box.installed ? "/usr/bin/VBoxManage" : null),
    vboxSearched: () => ["/usr/bin/VBoxManage", "/usr/lib/virtualbox/VBoxManage"],
    async exec(argv) {
      calls.push(argv);
      if (argv[0] === "/usr/bin/VBoxManage" && argv[1] === "--version") return box.installed ? { code: 0, stdout: `${box.installed}r175245\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      if (argv[0] === "/usr/bin/VBoxManage" && argv[1] === "list") return { code: 0, stdout: argv[2] === "extpacks" ? "Extension Packs: 0\n" : "", stderr: "" };
      if (argv[0] === "pkexec") {
        scripts.push(readFileSync(argv[2]!, "utf8"));
        if (o.pkexec) return { code: o.pkexec, stdout: "", stderr: "Error executing command as another user: Not authorized" };
        const s = scripts.at(-1)!;
        const out: string[] = [];
        if (s.includes("mokutil --import")) { if (box.mok !== "enrolled") { box.mok = "pending"; out.push("PEH: MOK_REQUESTED"); } }
        if (s.includes("enable_virt_at_load=0")) { if (!o.kvmInUse) { box.virtAtLoad = false; out.push("PEH: KVM_RELOADED"); } else out.push("PEH: KVM_IN_USE"); }
        if (s.includes("apt-get install")) {
          if (o.aptFails) return { code: 23, stdout: "E: Unable to locate package 7zip\nPEH: APT_FAILED\n", stderr: "" };
          box.installed = pin.version; out.push("PEH: APT_OK");
          box.drv = o.drvAfterInstall ?? (o.sb !== true);
        }
        out.push("PEH: ROOT_DONE");
        return { code: 0, stdout: out.join("\n") + "\n", stderr: "" };
      }
      if (argv[0] === "systemctl" && argv[1] === "reboot") { box.boot = "boot-B"; box.drv = box.mok === "pending" ? (box.mok = "enrolled", true) : true; if (box.virtAtLoad === true) box.virtAtLoad = false; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 127, stdout: "", stderr: `unknown ${argv[0]}` };
    },
    fetch: (async () => new Response(DEB, { headers: { "content-length": String(DEB.length) } })) as unknown as typeof fetch,
  };
  const host: LinuxHost = {
    osRelease: () => 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nVERSION_ID="24.04"\n',
    cpuinfo: () => "flags\t\t: fpu vme vmx sse\n",
    secureBoot: () => o.sb ?? false,
    kernel: () => o.kernel ?? "6.8.0-48-generic",
    kvmVirtAtLoad: () => box.virtAtLoad,
    hasVboxDrv: () => box.drv,
    mokState: async () => box.mok,
    bootId: () => box.boot,
    setupLog: () => "vboxdrv.sh: failed: Look at /var/log/vbox-setup.log to find out what went wrong.",
    resumeAtLogin: (on) => { box.resume = on; },
  };
  return { sys, host, box, calls, scripts };
}

async function run(f: ReturnType<typeof fakeUbuntu>, answered: string[] = []) {
  const lines: string[] = [];
  try { await linuxVirtualboxStep(f.sys, f.host, pin).run({ signal: new AbortController().signal, progress: () => {}, answered, log: (l) => lines.push(l) }); return { ok: true as const, lines }; }
  catch (e) { return { ok: false as const, lines, failure: (e as { failure?: StepFailure }).failure, question: (e as { question?: StepQuestion }).question }; }
}

describe("Ubuntu VirtualBox step (F14)", () => {
  test("ISC-68 pinned to Oracle's noble .deb with Oracle's published SHA-256, and a damaged download is thrown away", async () => {
    expect(VIRTUALBOX_NOBLE.url).toBe("https://download.virtualbox.org/virtualbox/7.2.22/virtualbox-7.2_7.2.22-175245~Ubuntu~noble_amd64.deb");
    expect(VIRTUALBOX_NOBLE.sha256).toBe("426f192dc4515cd02a687a39408c0b6b0d7741de77ff7c345efd92e6090c96ee");
    const f = fakeUbuntu();
    const ok = await run(f);
    expect(ok.ok).toBe(true);
    expect(existsSync(join(f.sys.cacheDir, pin.file))).toBe(true);
    const bad = fakeUbuntu();
    bad.sys.fetch = (async () => new Response("tampered", { headers: { "content-length": "8" } })) as unknown as typeof fetch;
    const r = await run(bad);
    expect(r.failure?.code).toBe("VBOX-SHA");
    expect(existsSync(join(bad.sys.cacheDir, pin.file))).toBe(false);
    expect(bad.calls.some((c) => c[0] === "pkexec")).toBe(false);
  });

  test("ISC-69 one pkexec prompt runs everything that needs root, and a dismissed prompt asks for the password", async () => {
    const f = fakeUbuntu({ sb: true, kernel: "6.14.0-36-generic", virtAtLoad: true });
    await run(f);
    expect(f.calls.filter((c) => c[0] === "pkexec")).toHaveLength(1);
    expect(f.calls.find((c) => c[0] === "pkexec")!.slice(0, 2)).toEqual(["pkexec", "/bin/bash"]);
    const s = f.scripts[0]!;
    expect(s).toContain("mokutil --import");
    expect(s).toContain("enable_virt_at_load=0");
    expect(s).toMatch(/apt-get install -y -q '.+noble_amd64\.deb' 7zip/);
    expect(s.indexOf('linux-headers-$(uname -r)')).toBeLessThan(s.indexOf("noble_amd64.deb' 7zip")); // headers for the running kernel before the module build
    // The key exists before apt runs, so the .deb's postinst signs its modules with it.
    expect(s.indexOf("MOK.der")).toBeLessThan(s.indexOf("apt-get install"));
    expect(existsSync(join(f.sys.cacheDir, "root-setup.sh"))).toBe(false);
    for (const code of [126, 127]) {
      const r = await run(fakeUbuntu({ pkexec: code }));
      expect(r.failure?.code).toBe("LNX-AUTH");
      expect(r.failure?.todo).toContain("password");
    }
    const apt = await run(fakeUbuntu({ aptFails: true }));
    expect(apt.failure?.code).toBe("LNX-APT");
    expect(apt.failure?.detail).toContain("Unable to locate package");
  });

  test("ISC-70 the real root script makes the key, requests enrollment with the kept 8-digit password, and leaves a readable copy", async () => {
    const d = tmp("root-"), bin = join(d, "bin"), mok = join(d, "mok"), cache = join(d, "cache"), log = join(d, "calls.log");
    mkdirSync(bin); mkdirSync(cache);
    const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${log}\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub("update-secureboot-policy", `case "$1" in --help) echo "--new-key --enroll-key";; --new-key) mkdir -p ${mok}; echo der > ${mok}/MOK.der; echo priv > ${mok}/MOK.priv;; esac`);
    stub("mokutil", `case "$1" in --test-key) echo "$2 is not enrolled";; --import) cat > ${d}/stdin.txt;; esac`);
    stub("apt-get", "exit 0");
    const { mokPassword } = await import("../src/linux");
    const pw = mokPassword(cache);
    expect(pw).toMatch(/^\d{8}$/);
    expect(mokPassword(cache)).toBe(pw); // kept: every screen shows the same one
    const script = rootScript({ deb: join(cache, "vb.deb"), cacheDir: cache, uid: process.getuid!(), gid: process.getgid!(), secureBoot: true, mokPassword: pw, kvmFix: false, mokDir: mok });
    const p = Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    expect(out).toContain("PEH: MOK_KEY_CREATED");
    expect(out).toContain("PEH: MOK_REQUESTED");
    expect(out).toContain("PEH: ROOT_DONE");
    expect(readFileSync(join(d, "stdin.txt"), "utf8")).toBe(`${pw}\n${pw}\n`);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("mokutil --timeout -1"); // MokManager waits instead of booting on after 10 s
    expect(calls).not.toContain(pw); // never on a command line
    expect(readFileSync(join(cache, "mok.der"), "utf8")).toBe("der\n");
    // Already requested or enrolled: no second request, so the password can't change under the student.
    stub("mokutil", `case "$1" in --test-key) echo "$2 is already in the enrollment request";; --import) echo IMPORTED >> ${log};; esac`);
    const again = Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(again.stdout.toString()).toContain("PEH: MOK_PENDING");
    expect(readFileSync(log, "utf8")).not.toContain("IMPORTED");
    expect(parseMokTest("/x/MOK.der is already enrolled")).toBe("enrolled");
    expect(parseMokTest("SKIP: /x/MOK.der is already in the enrollment request")).toBe("pending");
    expect(parseMokTest("/x/MOK.der is not enrolled")).toBe("not-enrolled");
  });

  test("ISC-71 a pending enrollment asks needs-you with the password and MokManager steps; the button restarts once; the run finishes after", async () => {
    const f = fakeUbuntu({ sb: true });
    const first = await run(f);
    expect(first.question?.code).toBe("LNX-RESTART");
    const pw = readFileSync(join(f.sys.cacheDir, "mok-password.txt"), "utf8");
    expect(first.question?.what).toContain(pw);
    expect(first.question?.steps).toEqual(MOK_STEPS(pw));
    expect(first.question?.steps?.join(" ")).toMatch(/Enroll MOK.*Continue.*Yes.*Reboot/);
    expect(first.question?.confirm).toBe("Restart my PC");
    expect(f.calls.some((c) => c[0] === "systemctl")).toBe(false); // never without the button

    const pressed = await run(f, ["LNX-RESTART"]);
    expect(f.calls.filter((c) => c[0] === "systemctl")).toEqual([["systemctl", "reboot"]]);
    expect(f.box.resume).toBe(true); // opens again at the next login
    expect(pressed.question?.code).toBe("LNX-RESTARTING");

    // After the restart: a different boot, the key enrolled at MokManager, the driver loaded at boot.
    const after = await run(f, ["LNX-RESTART"]);
    expect(after.ok).toBe(true);
    expect(f.calls.filter((c) => c[0] === "systemctl")).toHaveLength(1); // no second restart
    expect(f.box.resume).toBe(false);
  });

  test("ISC-71 a stale yes never restarts: after a restart that didn't fix it, the step asks again and waits", async () => {
    const f = fakeUbuntu({ sb: true });
    await run(f);
    f.box.boot = "boot-B"; // restarted, but the blue screen was skipped
    const r = await run(f, ["LNX-RESTART"]);
    expect(r.question?.code).toBe("LNX-RESTART");
    expect(f.calls.some((c) => c[0] === "systemctl")).toBe(false);
  });

  test("ISC-71 the runner forgets a yes when the same question is asked again", async () => {
    const d = tmp("ans-");
    const cfg: Config = { ...defaultConfig(), realSteps: new Set(), platform: "linux", stateDir: join(d, "s"), downloadsDir: join(d, "dl"), msPerMinute: 2 };
    const app = createApp(cfg);
    let asks = 0; const seen: (string[] | undefined)[] = [];
    (app.runner as unknown as { makeStep: (id: string) => unknown }).makeStep = (id: string) => ({ id, ...STEP_INFO.virtualbox, async run(ctx: { answered?: string[] }) { seen.push(ctx.answered); if (asks++ < 2) throw Object.assign(new Error("q"), { question: { code: "LNX-RESTART", what: "w", todo: "t", confirm: "c" } }); } });
    app.runner.start("kali", ["virtualbox"]);
    await Bun.sleep(20);
    expect(app.runner.state?.question?.code).toBe("LNX-RESTART");
    app.runner.confirm();
    await Bun.sleep(20);
    expect(seen[1]).toEqual(["LNX-RESTART"]);
    expect(app.runner.state?.answered ?? []).not.toContain("virtualbox:LNX-RESTART"); // asked again, so the yes is spent
  });

  test("ISC-72 kernels 6.12-6.15 with KVM holding VT-x get the KVM option; 6.8 and 6.16+ are left alone", async () => {
    expect(["6.8.0-48-generic", "6.11.0-29-generic", "6.16.0-7-generic", "6.17.0-5-generic", "7.1.0"].map(kernelNeedsKvmOption)).toEqual([false, false, false, false, false]);
    expect(["6.12.0", "6.14.0-36-generic", "6.15.9"].map(kernelNeedsKvmOption)).toEqual([true, true, true]);
    const fix = fakeUbuntu({ kernel: "6.14.0-36-generic", virtAtLoad: true });
    expect((await run(fix)).ok).toBe(true);
    expect(fix.scripts[0]).toContain("options kvm enable_virt_at_load=0");
    const inUse = fakeUbuntu({ kernel: "6.14.0-36-generic", virtAtLoad: true, kvmInUse: true });
    const q = await run(inUse);
    expect(q.question?.code).toBe("LNX-RESTART");
    expect(q.question?.steps).toBeUndefined();
    const ga = fakeUbuntu({ kernel: "6.8.0-48-generic", virtAtLoad: true });
    await run(ga);
    expect(ga.scripts[0]).not.toContain("enable_virt_at_load");
    // The real script's KVM lines run in bash with a stand-in modprobe and a temp conf path.
    const d = tmp("kvm-"), bin = join(d, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "modprobe"), "#!/bin/bash\nexit 0\n"); chmodSync(join(bin, "modprobe"), 0o755);
    const conf = join(d, "peh-lab-kvm.conf");
    const p = Bun.spawnSync(["bash", "-c", rootScript({ deb: null, cacheDir: d, uid: 0, gid: 0, secureBoot: false, mokPassword: "12345678", kvmFix: true, kvmConf: conf })], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(p.stdout.toString()).toContain("PEH: KVM_RELOADED");
    expect(readFileSync(conf, "utf8")).toBe("options kvm enable_virt_at_load=0\n");
  });

  test("ISC-73 passes only with the driver loaded and 7.2.22; a missing driver with no restart owed fails LNX-DRIVER with the setup log", async () => {
    const done = fakeUbuntu({ installed: "7.2.22", drv: true });
    expect((await run(done)).ok).toBe(true);
    expect(done.calls.some((c) => c[0] === "pkexec")).toBe(false); // ISC-14 skip
    const noDrv = fakeUbuntu({ drvAfterInstall: false });
    const r = await run(noDrv);
    expect(r.failure?.code).toBe("LNX-DRIVER");
    expect(r.failure?.detail).toContain("vbox-setup.log");
  });

  test("ISC-74 the Linux PC check reads CPU flags, Secure Boot and the Ubuntu version", async () => {
    const d = tmp("chk-");
    const base: Config = { ...defaultConfig(), realSteps: new Set(), platform: "linux", stateDir: join(d, "s"), downloadsDir: d, msPerMinute: 2 };
    const ubuntu = 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nVERSION_ID="24.04"\n';
    const on = await pcCheck({ ...base, linuxProbe: () => ({ osRelease: ubuntu, cpuinfo: "flags\t: fpu svm sse", secureBoot: true }) });
    expect(on.map((c) => c.id)).toEqual(["virtualization", "ram", "disk", "secureboot", "system"]);
    expect(on[0]!.verdict).toBe("pass");
    const sbRow = on.find((c) => c.id === "secureboot")!;
    expect(sbRow.verdict).toBe("warn"); // a heads-up, never a blocker
    expect(sbRow.advice).not.toMatch(/turn (it )?off|disable/i);
    expect(on.find((c) => c.id === "system")!.verdict).toBe("pass");
    const off = await pcCheck({ ...base, linuxProbe: () => ({ osRelease: 'PRETTY_NAME="Fedora Linux 41"\nID=fedora\nVERSION_ID=41\n', cpuinfo: "flags\t: fpu sse", secureBoot: null }) });
    expect(off[0]!.verdict).toBe("fail");
    expect(off.find((c) => c.id === "secureboot")!.verdict).toBe("pass");
    expect(off.find((c) => c.id === "system")!.verdict).toBe("warn");
    expect(off.find((c) => c.id === "system")!.value).toBe("Fedora Linux 41");
  });

  test("ISC-75 Kali import and fixes take the Linux VBoxManage path; Kali is unpacked with Ubuntu's 7z; NOVBOX names Linux paths", async () => {
    const { kaliDownloadStep } = await import("../src/kali");
    const { KALI, SEVENZR, PIMPMYKALI } = await import("../src/pins");
    const { pimpmykaliStep } = await import("../src/pimpmykali");
    const archive = new TextEncoder().encode("kali archive");
    const f = fakeUbuntu({ installed: "7.2.22", drv: true });
    const seven: string[][] = [];
    f.sys.fetch = (async () => new Response(archive, { headers: { "content-length": String(archive.length) } })) as unknown as typeof fetch;
    const exec = f.sys.exec;
    f.sys.exec = async (argv) => { if (argv[0] === "7z") { seven.push(argv); const out = argv.find((a) => a.startsWith("-o"))!.slice(2); mkdirSync(join(out, "kali"), { recursive: true }); writeFileSync(join(out, "kali", "kali.vbox"), "x"); return { code: 0, stdout: "", stderr: "" }; } return exec(argv); };
    await kaliDownloadStep(f.sys, { ...KALI, sha256: createHash("sha256").update(archive).digest("hex") }, SEVENZR).run({ signal: new AbortController().signal, progress: () => {} });
    expect(seven).toHaveLength(1);
    expect(existsSync(join(f.sys.cacheDir, SEVENZR.file))).toBe(false); // no 7zr.exe on Ubuntu
    const gone = fakeUbuntu();
    const e = await pimpmykaliStep(gone.sys, PIMPMYKALI).run({ progress: () => {}, signal: new AbortController().signal } as never).catch((x) => x);
    expect(e.failure.code).toBe("PMK-NOVBOX");
    expect(e.failure.detail).toContain("/usr/bin/VBoxManage");
    expect(e.failure.detail).not.toContain(".exe");
  });

  test("ISC-76 no Linux screen, step text, question or failure mentions Windows, UAC or .exe; Windows text unchanged", async () => {
    const windowsy = /windows|uac|\.exe/i;
    expect(JSON.stringify(stepInfo("linux"))).not.toMatch(windowsy);
    expect(stepInfo("win32").virtualbox.detail).toBe(STEP_INFO.virtualbox.detail);
    expect(STEP_INFO.virtualbox.detail).toContain("Windows will ask for permission");
    const d = tmp("prof-");
    const app = createApp({ ...defaultConfig(), realSteps: new Set(), platform: "linux", stateDir: join(d, "s"), downloadsDir: d, msPerMinute: 2 });
    const prof = await (await app.handle(new Request("http://127.0.0.1/api/profiles"))).json();
    expect(JSON.stringify(prof.steps)).not.toMatch(windowsy);
    expect(prof.steps.virtualbox.detail).toContain("Ubuntu will ask for your password");
    // Every outcome of the Linux step, as the student would read it.
    const said: string[] = [];
    const outcomes = [
      await run(fakeUbuntu()), await run(fakeUbuntu({ sb: true })), await run(fakeUbuntu({ pkexec: 126 })), await run(fakeUbuntu({ aptFails: true })),
      await run(fakeUbuntu({ drvAfterInstall: false })), await run(fakeUbuntu({ kernel: "6.14.0", virtAtLoad: true, kvmInUse: true })),
    ];
    for (const o of outcomes) { said.push(...o.lines); if (!o.ok) said.push(JSON.stringify(o.failure ?? {}), JSON.stringify(o.question ?? {})); }
    expect(said.join("\n")).not.toMatch(windowsy);
    // The page loads the server's step text in real mode.
    const ui = readFileSync(join(import.meta.dir, "..", "ui", "index.html"), "utf8");
    expect(ui).toMatch(/fetch\("\/api\/profiles"[\s\S]{0,120}Object\.assign\(STEPS, p\.steps\)/);
  });
});
