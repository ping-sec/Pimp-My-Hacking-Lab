import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIMPMYKALI } from "../src/pins";
import { pimpmykaliStep, PMK_DONE } from "../src/pimpmykali";
import { KALI_VM_NAME } from "../src/kali";
import type { Sys } from "../src/virtualbox";
import type { StepFailure } from "../src/steps";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake Kali: boots after `bootPolls` guest probes, finishes PMK after `runPolls` log polls. */
function fakeSys(o: { bootPolls?: number; never?: boolean; runPolls?: number; logEnd?: string; dropouts?: number; acpiWorks?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "pmk-")); dirs.push(cacheDir);
  const calls: string[][] = [];
  let state = "poweroff", probes = 0, polls = 0, dropouts = o.dropouts ?? 0, started = false;
  const sys: Sys = {
    platform: "win32", env: {}, cacheDir,
    vboxManagePath: () => "C:\\VB\\VBoxManage.exe",
    sleep: async () => {},
    async exec(argv) {
      calls.push(argv);
      const [, cmd, vm, sub, ...rest] = argv;
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (cmd === "list") return ok(`"${KALI_VM_NAME}" {uuid}`);
      if (cmd === "showvminfo") return ok(`VMState="${state}"`);
      if (cmd === "startvm") { state = "running"; return ok(); }
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
