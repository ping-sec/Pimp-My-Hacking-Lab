import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIMPMYKALI } from "../src/pins";
import { pimpmykaliStep, PMK_DONE, pollScript, runCommand } from "../src/pimpmykali";
import { KALI_VM_NAME } from "../src/kali";
import type { Sys } from "../src/virtualbox";
import type { StepFailure } from "../src/steps";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake Kali: boots after `bootPolls` guest probes, finishes PMK after `runPolls` log polls. */
function fakeSys(o: { bootPolls?: number; never?: boolean; runPolls?: number; logEnd?: string; dropouts?: number; acpiWorks?: boolean; startErr?: string; savedMismatch?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "pmk-")); dirs.push(cacheDir);
  const calls: string[][] = [];
  let state = o.savedMismatch ? "aborted-saved" : "poweroff", probes = 0, polls = 0, dropouts = o.dropouts ?? 0, started = false;
  const sys: Sys = {
    platform: "win32", env: {}, cacheDir,
    vboxManagePath: () => "C:\\VB\\VBoxManage.exe",
    sleep: async () => {},
    async exec(argv) {
      calls.push(argv);
      const [, cmd, vm, sub, ...rest] = argv;
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (cmd === "list" && vm === "hostonlyifs") return ok("Name:            VirtualBox Host-Only Ethernet Adapter\n");
      if (cmd === "list") return ok(`"${KALI_VM_NAME}" {uuid}`);
      if (cmd === "showvminfo") return ok(`VMState="${state}"`);
      if (cmd === "discardstate") { state = "poweroff"; return ok(); }
      if (cmd === "startvm" && state.includes("saved") && o.savedMismatch) return { code: 1, stdout: "", stderr: "VBoxManage.exe: error: apic#0: Config mismatch - uApicMode: saved=2 config=3 [ver=5 pass=final] (VERR_SSM_LOAD_CONFIG_MISMATCH)" };
      if (cmd === "startvm") { if (o.startErr) return { code: 1, stdout: "", stderr: o.startErr }; state = "running"; return ok(); }
      if (cmd === "controlvm" && vm === KALI_VM_NAME && sub === "acpipowerbutton") { if (o.acpiWorks !== false) state = "poweroff"; return ok(); }
      if (cmd === "controlvm" && sub === "poweroff") { state = "poweroff"; return ok(); }
      if (cmd === "guestcontrol") {
        // VirtualBox 7.2: everything after "--" is argv[1..]; a repeated argv[0] makes bash run its own binary
        const after = argv.slice(argv.indexOf("--") + 1);
        if (after[0] === "/bin/bash") return { code: 126, stdout: "", stderr: "/bin/bash: /bin/bash: cannot execute binary file" };
        const script = argv.at(-1)!;
        if (script === "true") { probes++; return !o.never && probes > (o.bootPolls ?? 0) ? ok() : { code: 1, stdout: "", stderr: "VBoxManage: error: The guest execution service is not ready (yet)" }; }
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
  return { sys, calls };
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
  chmodSync(join(d, "bin", "sudo"), 0o755);
  const o = { dir: d, log: join(d, "pmk.log"), pid: join(d, "pmk.pid"), shim: join(d, ".peh-shim") };
  return { d, o, env: { PATH: `${join(d, "bin")}:${process.env.PATH}` } };
}

describe("PimpMyKali in real bash", () => {
  test("ISC-52 PimpMyKali gets the guest user from logname, for that run only", async () => {
    const { o, env } = realKali();
    await bash(runCommand(o), env);
    expect(existsSync(join(o.shim, "logname"))).toBe(true); // present while it runs
    for (let i = 0; i < 50 && (await bash(pollScript(o), env)).includes("PEH_RUNNING"); i++) await Bun.sleep(100);
    const log = readFileSync(o.log, "utf8");
    expect(log).toContain("user=[kali] args=--autonoroot");
    expect(log).toContain("All Done! Happy Hacking!");
    expect(existsSync(o.shim)).toBe(false); // gone afterwards
    expect(runCommand(o)).not.toMatch(/\/usr\/(local\/)?s?bin\/logname/); // never installed system-wide
  });
  test("ISC-53 the real poll sees PimpMyKali run and then stop, by PID", async () => {
    const { o, env } = realKali();
    expect(pollScript(o)).not.toContain("pgrep");
    expect(await bash(pollScript(o), env)).toContain("PEH_STOPPED"); // nothing launched yet
    await bash(runCommand(o), env);
    expect(await bash(pollScript(o), env)).toContain("PEH_RUNNING");
    let polls = 0;
    while ((await bash(pollScript(o), env)).includes("PEH_RUNNING")) { if (++polls > 50) throw new Error("never stopped"); await Bun.sleep(100); }
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
