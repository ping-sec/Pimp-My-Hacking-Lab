import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIMPMYKALI } from "../src/pins";
import { gaPollScript, pimpmykaliStep, PMK_DONE, pollScript, runCommand } from "../src/pimpmykali";
import { KALI_VM_NAME } from "../src/kali";
import type { Sys } from "../src/virtualbox";
import type { StepFailure } from "../src/steps";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake Kali: boots after `bootPolls` guest probes, finishes PMK after `runPolls` log polls. */
function fakeSys(o: { bootPolls?: number; never?: boolean; runPolls?: number; logEnd?: string; dropouts?: number; acpiWorks?: boolean; startErr?: string; savedMismatch?: boolean; levelPolls?: number; duplicates?: number; gaRc?: number; gaLeft?: boolean; netFail?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "pmk-")); dirs.push(cacheDir);
  const calls: string[][] = [];
  let state = o.savedMismatch ? "aborted-saved" : "poweroff", probes = 0, polls = 0, dropouts = o.dropouts ?? 0, started = false, infos = 0, duplicates = o.duplicates ?? 0;
  const early: string[] = []; // guest commands sent before run level 2 (ISC-59)
  const level = () => (state === "running" && infos > (o.levelPolls ?? 0) ? 2 : 0);
  const sys: Sys = {
    platform: "win32", env: {}, cacheDir,
    vboxManagePath: () => "C:\\VB\\VBoxManage.exe",
    sleep: async () => {},
    async exec(argv) {
      calls.push(argv);
      const [, cmd, vm, sub, ...rest] = argv;
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (cmd === "list" && vm === "hostonlyifs") return ok(o.netFail ? "" : "Name:            VirtualBox Host-Only Ethernet Adapter\n");
      if (cmd === "hostonlyif" && vm === "create" && o.netFail) return { code: 1, stdout: "0%...E_FAIL", stderr: "VBoxManage.exe: error: Could not find Host Interface Networking driver! Please reinstall" };
      if (cmd === "list") return ok(`"${KALI_VM_NAME}" {uuid}`);
      if (cmd === "showvminfo") { if (state === "running") infos++; return ok(`VMState="${state}"\nGuestAdditionsRunLevel=${level()}`); }
      if (cmd === "discardstate") { state = "poweroff"; return ok(); }
      if (cmd === "startvm" && state.includes("saved") && o.savedMismatch) return { code: 1, stdout: "", stderr: "VBoxManage.exe: error: apic#0: Config mismatch - uApicMode: saved=2 config=3 [ver=5 pass=final] (VERR_SSM_LOAD_CONFIG_MISMATCH)" };
      if (cmd === "startvm") { if (o.startErr) return { code: 1, stdout: "", stderr: o.startErr }; state = "running"; return ok(); }
      if (cmd === "controlvm" && vm === KALI_VM_NAME && sub === "acpipowerbutton") { if (o.acpiWorks !== false) state = "poweroff"; return ok(); }
      if (cmd === "controlvm" && sub === "poweroff") { state = "poweroff"; return ok(); }
      if (cmd === "guestcontrol" && sub === "closesession") { duplicates = 0; return ok(); }
      if (cmd === "guestcontrol") {
        if (level() < 2) early.push(argv.at(-1)!);
        if (duplicates > 0) return { code: 1, stdout: "", stderr: "VBoxManage.exe: error: Waiting for guest process failed: VERR_DUPLICATE" };
        // VirtualBox 7.2: everything after "--" is argv[1..]; a repeated argv[0] makes bash run its own binary
        const after = argv.slice(argv.indexOf("--") + 1);
        if (after[0] === "/bin/bash") return { code: 126, stdout: "", stderr: "/bin/bash: /bin/bash: cannot execute binary file" };
        const script = argv.at(-1)!;
        if (script === "true") { probes++; return !o.never && probes > (o.bootPolls ?? 0) ? ok() : { code: 1, stdout: "", stderr: "VBoxManage: error: The guest execution service is not ready (yet)" }; }
        if (script.includes("PEH_GA_WAIT")) return ok(`Setting up virtualbox-guest-utils ...\nPEH_GA_DONE rc=${o.gaRc ?? 0} left=${o.gaLeft ? 1 : 0}`);
        if (script.includes("nohup")) { started = true; return ok("PEH_STARTED"); }
        if (script.includes("PEH_RUNNING")) {
          if (dropouts > 0) { dropouts--; return { code: 1, stdout: "", stderr: "VBoxManage: error: Guest Additions are not running" }; }
          polls++;
          const running = started && polls <= (o.runPolls ?? 2);
          return ok(running ? "Installing...\nPEH_RUNNING" : `${o.logEnd ?? "    All Done! Happy Hacking!"}\nPEH_STOPPED`);
        }
      }
      return ok();
    },
    fetch: (async () => new Response("")) as unknown as typeof fetch,
  };
  return { sys, calls, early };
}
async function run(sys: Sys) {
  const fr: number[] = [];
  try { await pimpmykaliStep(sys, PIMPMYKALI).run({ signal: new AbortController().signal, progress: (f) => fr.push(f) }); return { ok: true as const, fr }; }
  catch (e) { return { ok: false as const, fr, failure: (e as { failure?: StepFailure }).failure }; }
}
const guestScripts = (calls: string[][]) => calls.filter((c) => c[1] === "guestcontrol").map((c) => c.at(-1)!);

describe("PimpMyKali step", () => {
  test("ISC-43 guestcontrol passes only the arguments after --, never a repeated argv[0]", async () => {
    const { sys, calls } = fakeSys();
    expect((await run(sys)).ok).toBe(true);
    const gc = calls.filter((c) => c[1] === "guestcontrol");
    expect(gc.length).toBeGreaterThan(0);
    for (const c of gc) { const i = c.indexOf("--"); expect(c[i - 1]).toBe("/bin/bash"); expect(c.slice(i + 1, i + 2)).toEqual(["-c"]); expect(c.length).toBe(i + 3); }
  });
  test("ISC-45 a boot timeout keeps the guest tools error text", async () => {
    const { sys } = fakeSys({ never: true });
    const r = await run(sys);
    expect(r.failure?.code).toBe("PMK-BOOT");
    expect(r.failure?.detail).toContain("guest execution service is not ready");
  });
  test("ISC-26 pinned commit and SHA-256, checked inside Kali before running", async () => {
    expect(PIMPMYKALI.build).toMatch(/^[0-9a-f]{40}$/);
    expect(PIMPMYKALI.url).toBe(`https://raw.githubusercontent.com/Dewalt-arch/pimpmykali/${PIMPMYKALI.build}/pimpmykali.sh`);
    expect(PIMPMYKALI.sha256).toMatch(/^[0-9a-f]{64}$/);
    const { sys, calls } = fakeSys();
    await run(sys);
    const launch = guestScripts(calls).find((s) => s.includes("nohup"))!;
    expect(launch).toContain(PIMPMYKALI.url);
    expect(launch.indexOf("sha256sum -c")).toBeLessThan(launch.indexOf("pimpmykali.sh --autonoroot"));
  });
  test("ISC-27 boots headless and waits for guest tools; a timeout fails plainly", async () => {
    const { sys, calls } = fakeSys({ bootPolls: 3 });
    expect((await run(sys)).ok).toBe(true);
    expect(calls.find((c) => c[1] === "startvm")!.join(" ")).toContain("--type headless");
    const dead = fakeSys({ never: true });
    const r = await run(dead.sys);
    expect(r.failure!.code).toBe("PMK-BOOT");
  });
  test("ISC-28 runs detached as root with --autonoroot; success comes from the log", async () => {
    const { sys, calls } = fakeSys();
    expect((await run(sys)).ok).toBe(true);
    const launch = guestScripts(calls).find((s) => s.includes("nohup"))!;
    expect(launch).toContain("sudo -S");
    expect(launch).toContain("pimpmykali.sh --autonoroot");
    const bad = fakeSys({ logEnd: "E: Unable to locate package foo" });
    const r = await run(bad.sys);
    expect(r.failure!.code).toBe("PMK-FAIL");
  });
  test("ISC-29 rides out guest-tools dropouts mid-run", async () => {
    const { sys } = fakeSys({ dropouts: 3 });
    expect((await run(sys)).ok).toBe(true);
  });
  test("ISC-30 shuts Kali down cleanly, falls back to power-off, and skips next time", async () => {
    const { sys, calls } = fakeSys();
    await run(sys);
    expect(calls.some((c) => c[1] === "controlvm" && c[3] === "acpipowerbutton")).toBe(true);
    expect(existsSync(join(sys.cacheDir, PMK_DONE))).toBe(true);
    const before = calls.length;
    expect((await run(sys)).ok).toBe(true);
    expect(calls.slice(before).some((c) => c[1] === "startvm")).toBe(false);
    const stuck = fakeSys({ acpiWorks: false });
    expect((await run(stuck.sys)).ok).toBe(true);
    expect(stuck.calls.some((c) => c[1] === "controlvm" && c[3] === "poweroff")).toBe(true);
  });
});

/** A real bash run of the real launch and poll commands, against a stand-in pimpmykali.sh. */
async function bash(cmd: string, env: Record<string, string>) {
  const p = Bun.spawn(["bash", "-c", cmd], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return out + err;
}
function realKali() {
  const d = mkdtempSync(join(tmpdir(), "pmk-real-")); dirs.push(d);
  mkdirSync(join(d, "bin"));
  // PimpMyKali's own first move: finduser=$(logname)
  writeFileSync(join(d, "pimpmykali.sh"), '#!/bin/sh\nfinduser=$(logname 2>/dev/null)\necho "user=[$finduser] args=$*"\nsleep 1\necho "All Done! Happy Hacking!"\n');
  chmodSync(join(d, "pimpmykali.sh"), 0o755);
  // sudo stand-in: take the password from stdin (-S), then run the command
  writeFileSync(join(d, "bin", "sudo"), '#!/bin/sh\n[ "$1" = "-S" ] && { read _pw; shift; }\nexec "$@"\n');
  // The job ends with the guest-tools cleanup (ISC-60) and may reboot (ISC-61): stand-ins only, never this machine's.
  writeFileSync(join(d, "bin", "apt-get"), `#!/bin/sh\necho "$DEBIAN_FRONTEND $*" >> ${join(d, "apt.txt")}\n`);
  writeFileSync(join(d, "bin", "reboot"), `#!/bin/sh\necho rebooted >> ${join(d, "reboot.txt")}\n`);
  for (const b of ["sudo", "apt-get", "reboot"]) chmodSync(join(d, "bin", b), 0o755);
  const opt = join(d, "opt");
  mkdirSync(opt);
  const o = { dir: d, log: join(d, "pmk.log"), pid: join(d, "pmk.pid"), shim: join(d, ".peh-shim") };
  return { d, o, ga: { opt, log: join(d, "ga.log") }, env: { PATH: `${join(d, "bin")}:${process.env.PATH}` } };
}

describe("PimpMyKali in real bash", () => {
  test("ISC-52 PimpMyKali gets the guest user from logname, for that run only", async () => {
    const { o, ga, env } = realKali();
    await bash(runCommand(o, ga), env);
    expect(existsSync(join(o.shim, "logname"))).toBe(true); // present while it runs
    for (let i = 0; i < 50 && (await bash(pollScript(o, ga), env)).includes("PEH_RUNNING"); i++) await Bun.sleep(100);
    const log = readFileSync(o.log, "utf8");
    expect(log).toContain("user=[kali] args=--autonoroot");
    expect(log).toContain("All Done! Happy Hacking!");
    expect(existsSync(o.shim)).toBe(false); // gone afterwards
    expect(runCommand(o)).not.toMatch(/\/usr\/(local\/)?s?bin\/logname/); // never installed system-wide
  });
  test("ISC-53 the real poll sees PimpMyKali run and then stop, by PID", async () => {
    const { o, ga, env } = realKali();
    expect(pollScript(o, ga)).not.toContain("pgrep");
    expect(await bash(pollScript(o, ga), env)).toContain("PEH_STOPPED"); // nothing launched yet
    await bash(runCommand(o, ga), env);
    expect(await bash(pollScript(o, ga), env)).toContain("PEH_RUNNING");
    let polls = 0;
    while ((await bash(pollScript(o, ga), env)).includes("PEH_RUNNING")) { if (++polls > 50) throw new Error("never stopped"); await Bun.sleep(100); }
    expect(polls).toBeLessThan(30); // the script sleeps 1 s, so it stops within ~1 s of polls
    // The bug this replaces: a command-line match finds the poll itself.
    expect(await bash("if pgrep -f pimpmykali.sh >/dev/null; then echo PEH_RUNNING; else echo PEH_STOPPED; fi", env)).toContain("PEH_RUNNING");
  });
  test("ISC-54 after the shutdown Kali gets its memory, CPUs and both networks", async () => {
    const { sys, calls } = fakeSys();
    expect((await run(sys)).ok).toBe(true);
    const off = calls.findIndex((c) => c[1] === "controlvm" && (c[3] === "acpipowerbutton" || c[3] === "poweroff"));
    const set = calls.findIndex((c) => c[1] === "modifyvm" && c.includes("--nic2"));
    expect(off).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(off);
    const args = calls[set];
    expect(args).toEqual(expect.arrayContaining(["--cpus", "2", "--nic1", "nat", "--nic2", "hostonly"]));
    expect(args).not.toContain("bridged");
  });
  test("ISC-55 a failed start keeps VirtualBox's own error text for the help bundle", async () => {
    const err = 'VBoxManage.exe: error: The machine "Kali (PEH)" is already locked by a session (or being locked or unlocked)';
    const r = await run(fakeSys({ startErr: err }).sys);
    expect(r.failure!.code).toBe("PMK-START");
    expect(r.failure!.detail).toContain("already locked by a session");
  });
  test("ISC-56 a saved Kali that won't restore is discarded and booted fresh, once", async () => {
    const { sys, calls } = fakeSys({ savedMismatch: true });
    expect((await run(sys)).ok).toBe(true);
    const i = calls.findIndex((c) => c[1] === "discardstate");
    expect(i).toBeGreaterThan(-1);
    expect(calls.slice(i).some((c) => c[1] === "startvm")).toBe(true);
    expect(calls.filter((c) => c[1] === "discardstate").length).toBe(1);
  });
});

describe("guest sessions", () => {
  test("ISC-59 no guest command is sent before Guest Additions reach run level 2", async () => {
    const { sys, early } = fakeSys({ levelPolls: 4 });
    expect((await run(sys)).ok).toBe(true);
    expect(early).toEqual([]);
  });
  test("ISC-59 VERR_DUPLICATE closes every guest session once and the command is tried again", async () => {
    const { sys, calls } = fakeSys({ duplicates: 1000 });
    const r = await run(sys);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c[1] === "guestcontrol" && c[3] === "closesession" && c[4] === "--all").length).toBe(1);
  });
});

describe("guest tools cleanup", () => {
  /** realKali plus Oracle's /opt copy (by default). */
  function realGa(o2: { withOracle?: boolean; pmkFails?: boolean } = {}) {
    const k = realKali();
    if (o2.pmkFails) { writeFileSync(join(k.d, "pimpmykali.sh"), "#!/bin/sh\nsleep 1\necho broke\nexit 1\n"); chmodSync(join(k.d, "pimpmykali.sh"), 0o755); }
    if (o2.withOracle !== false) {
      const ga = join(k.ga.opt, "VBoxGuestAdditions-7.2.22");
      mkdirSync(ga);
      // Oracle's uninstaller removes its own folder
      writeFileSync(join(ga, "uninstall.sh"), `#!/bin/sh\nrm -rf ${ga}\necho uninstalled\n`);
      chmodSync(join(ga, "uninstall.sh"), 0o755);
    }
    return k;
  }
  async function runToEnd(k: ReturnType<typeof realGa>) {
    await bash(runCommand(k.o, k.ga), k.env);
    for (let i = 0; i < 60 && (await bash(pollScript(k.o, k.ga), k.env)).includes("PEH_RUNNING"); i++) await Bun.sleep(100);
    return bash(gaPollScript(k.ga), k.env);
  }
  test("ISC-60 the cleanup runs inside the PimpMyKali job, right after it, with no guest command of its own", async () => {
    const k = realGa();
    writeFileSync(k.ga.log, "PEH_GA_DONE rc=0 left=0\n"); // stale result from an earlier run
    await bash(runCommand(k.o, k.ga), k.env);
    expect(await bash(gaPollScript(k.ga), k.env)).toContain("PEH_GA_WAIT"); // cleared at launch
    for (let i = 0; i < 60 && (await bash(pollScript(k.o, k.ga), k.env)).includes("PEH_RUNNING"); i++) await Bun.sleep(100);
    expect(await bash(gaPollScript(k.ga), k.env)).toContain("PEH_GA_DONE rc=0 left=0");
    expect(existsSync(join(k.ga.opt, "VBoxGuestAdditions-7.2.22"))).toBe(false);
    expect(readFileSync(join(k.d, "apt.txt"), "utf8").trim()).toBe("noninteractive install --reinstall -y virtualbox-guest-utils virtualbox-guest-x11");
    expect(readFileSync(k.o.log, "utf8")).toContain("All Done! Happy Hacking!"); // PimpMyKali's own log untouched
  });
  test("ISC-60 the cleanup still runs when PimpMyKali fails", async () => {
    const k = realGa({ pmkFails: true });
    expect(await runToEnd(k)).toContain("PEH_GA_DONE rc=0 left=0");
    expect(existsSync(join(k.ga.opt, "VBoxGuestAdditions-7.2.22"))).toBe(false);
  });
  test("ISC-60 with no Oracle copy the cleanup changes nothing", async () => {
    const k = realGa({ withOracle: false });
    expect(await runToEnd(k)).toContain("PEH_GA_DONE rc=0 left=0");
    expect(existsSync(join(k.d, "apt.txt"))).toBe(false);
  });
  test("ISC-60 the step reads the cleanup result after PimpMyKali and before shutdown", async () => {
    const { sys, calls } = fakeSys();
    expect((await run(sys)).ok).toBe(true);
    const scripts = calls.map((c) => (c[1] === "guestcontrol" ? c.at(-1)! : ""));
    expect(scripts.find((s) => s.includes("nohup"))).toContain("VBoxGuestAdditions-*");
    const read = scripts.findIndex((s) => s.includes("PEH_GA_WAIT"));
    const off = calls.findIndex((c) => c[1] === "controlvm");
    expect(read).toBeGreaterThan(scripts.findLastIndex((s) => s.includes("PEH_RUNNING")));
    expect(off).toBeGreaterThan(read);
  });
  test("ISC-60 a failed cleanup stops the step as PMK-GA with the log", async () => {
    for (const bad of [{ gaRc: 100 }, { gaLeft: true }]) {
      const { sys } = fakeSys(bad);
      const r = await run(sys);
      expect(r.failure?.code).toBe("PMK-GA");
      expect(r.failure?.detail).toContain("PEH_GA_DONE");
    }
  });
  test("ISC-60 polls ride out a long guest-tools outage while they are mixed", async () => {
    const { sys } = fakeSys({ dropouts: 100 }); // ~33 minutes at 20 s per poll
    expect((await run(sys)).ok).toBe(true);
  });
});

describe("reboot after cleanup", () => {
  function withOracle() {
    const k = realKali();
    const ga = join(k.ga.opt, "VBoxGuestAdditions-7.2.22");
    mkdirSync(ga);
    writeFileSync(join(ga, "uninstall.sh"), `#!/bin/sh\nrm -rf ${ga}\n`);
    chmodSync(join(ga, "uninstall.sh"), 0o755);
    return k;
  }
  async function finish(k: ReturnType<typeof realKali>) {
    await bash(runCommand(k.o, k.ga), k.env);
    for (let i = 0; i < 80 && !existsSync(join(k.d, "reboot.txt")) && !(await bash(gaPollScript(k.ga), k.env)).includes("PEH_GA_DONE"); i++) await Bun.sleep(100);
    await Bun.sleep(4500); // the job syncs and waits 3 s before rebooting
  }
  test("ISC-61 Kali reboots after the cleanup removed Oracle's copy, once its result is written", async () => {
    const k = withOracle();
    await finish(k);
    expect(readFileSync(join(k.d, "reboot.txt"), "utf8").trim()).toBe("rebooted");
    expect(await bash(gaPollScript(k.ga), k.env)).toContain("PEH_GA_DONE rc=0 left=0");
  }, 15000);
  test("ISC-61 no reboot when there was no Oracle copy", async () => {
    const k = realKali();
    await finish(k);
    expect(existsSync(join(k.d, "reboot.txt"))).toBe(false);
  }, 15000);
  test("ISC-61 a finished cleanup means stopped, even if the old PID now belongs to another process", async () => {
    const k = realKali();
    writeFileSync(k.o.pid, `${process.pid}\n`); // after a reboot the recorded PID can be reused
    expect(await bash(pollScript(k.o, k.ga), k.env)).toContain("PEH_RUNNING");
    writeFileSync(k.ga.log, "PEH_GA_DONE rc=0 left=0\n");
    expect(await bash(pollScript(k.o, k.ga), k.env)).toContain("PEH_STOPPED");
  });
});

describe("settings after PimpMyKali", () => {
  test("ISC-62 a missing network driver is not retried in a loop (each try is a UAC prompt)", async () => {
    const { sys, calls } = fakeSys({ netFail: true });
    const r = await run(sys);
    expect(r.failure?.code).toBe("KALI-NET");
    expect(r.failure?.redo).toBe("virtualbox");
    expect(calls.filter((c) => c[1] === "hostonlyif" && c[2] === "create").length).toBe(1);
  });
  test("ISC-62 Try again after PimpMyKali and the cleanup succeeded goes straight to the settings", async () => {
    const o: { netFail?: boolean } = { netFail: true };
    const { sys, calls } = fakeSys(o);
    expect((await run(sys)).failure?.code).toBe("KALI-NET");
    o.netFail = false; // VirtualBox's driver added by the redo
    const before = calls.length;
    expect((await run(sys)).ok).toBe(true);
    const again = calls.slice(before);
    expect(again.some((c) => c[1] === "guestcontrol")).toBe(false); // PimpMyKali not run again
    expect(again.some((c) => c[1] === "modifyvm" && c.includes("--nic2"))).toBe(true);
  });
});
