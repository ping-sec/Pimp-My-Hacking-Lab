/**
 * Real "Apply Kali fixes" step (F6): boots Kali headless, runs PimpMyKali inside it with
 * `--autonoroot`, watches its log, then shuts Kali down cleanly.
 *
 * PimpMyKali reinstalls VirtualBox guest additions mid-run, which can drop guestcontrol, so it
 * runs detached (nohup) and the host polls its log, retrying dropped calls (ISC-29). Its final
 * `logname` call fails without a login TTY, so success is read from the log, never the exit code.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyKaliSettings, KALI_VM_NAME } from "./kali";
import type { Pin } from "./pins";
import { STEP_INFO, type Step, type StepFailure } from "./steps";
import type { Sys } from "./virtualbox";

export const PMK_DONE = "pimpmykali.done";
/** Kali's public default login for the pre-built image. */
const GUEST_USER = "kali", GUEST_PASS = "kali";
const LOG = "/home/kali/peh-pimpmykali.log";
const PID = "/home/kali/peh-pimpmykali.pid";
const SHIM = "/home/kali/.peh-shim";
/** Where the launch writes; tests point these at a temp dir. */
export interface RunPaths { dir: string; log: string; pid: string; shim: string }
const KALI_PATHS: RunPaths = { dir: "/home/kali", log: LOG, pid: PID, shim: SHIM };
const SUCCESS = "All Done! Happy Hacking!";

const fail = (code: string, what: string, todo: string, detail?: string): never => { throw Object.assign(new Error(what), { failure: { code, what, todo, ...(detail ? { detail } : {}) } satisfies StepFailure }); };
const errText = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim();

function manage(sys: Sys): string {
  const exe = sys.vboxManagePath();
  if (exe) return exe;
  throw Object.assign(new Error("no VirtualBox"), { failure: { code: "PMK-NOVBOX", what: "VirtualBox isn't on this PC anymore, so Kali can't be fixed up.", todo: "Press Try again. Setup installs VirtualBox again first.", redo: "virtualbox" } satisfies StepFailure }); // ISC-57
}
async function vm(sys: Sys, args: string[]) { return sys.exec([manage(sys), ...args]); }
async function vmState(sys: Sys): Promise<string> {
  const r = await vm(sys, ["showvminfo", KALI_VM_NAME, "--machinereadable"]);
  return r.stdout.match(/^VMState="([^"]+)"/m)?.[1] ?? "unknown";
}
/** One bash command inside Kali; the script is always the last argument. VirtualBox 7.2 passes
 *  everything after "--" as argv[1..], so argv[0] is never repeated there (ISC-43). */
async function guest(sys: Sys, script: string) {
  return vm(sys, ["guestcontrol", KALI_VM_NAME, "run", "--username", GUEST_USER, "--password", GUEST_PASS, "--exe", "/bin/bash", "--", "-c", script]);
}
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Starts PimpMyKali detached as root and records its PID (ISC-28, ISC-53). PimpMyKali reads its user from
 * `logname`, which is empty without a login session, so this run gets a `logname` that answers the guest user
 * from a shim directory first on its PATH; the shim is removed when the run ends (ISC-52).
 */
export function runCommand(o: RunPaths = KALI_PATHS): string {
  const path = `${o.shim}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const inner = `echo ${GUEST_PASS} | sudo -S env PATH=${sh(path)} ./pimpmykali.sh --autonoroot; rm -rf ${sh(o.shim)}`;
  return [
    `cd ${sh(o.dir)}`,
    `mkdir -p ${sh(o.shim)} && printf '#!/bin/sh\\necho ${GUEST_USER}\\n' > ${sh(`${o.shim}/logname`)} && chmod 755 ${sh(`${o.shim}/logname`)}`,
    `nohup sh -c ${sh(inner)} > ${sh(o.log)} 2>&1 < /dev/null &`,
    `echo $! > ${sh(o.pid)}`,
  ].join("\n");
}

/** The log tail, then whether the recorded PID is still alive; a command-line match would find the poll itself (ISC-53). */
export function pollScript(o: Pick<RunPaths, "log" | "pid"> = KALI_PATHS): string {
  return `tail -c 3000 ${sh(o.log)} 2>/dev/null; p=$(cat ${sh(o.pid)} 2>/dev/null); if [ -n "$p" ] && [ -d "/proc/$p" ]; then echo PEH_RUNNING; else echo PEH_STOPPED; fi`;
}

export function launchScript(pin: Pin): string {
  // Download the pinned script, check its SHA-256, then start it detached as root.
  return [
    "set -e", "cd /home/kali",
    `curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o pimpmykali.sh ${sh(pin.url)}`,
    `echo ${sh(`${pin.sha256}  pimpmykali.sh`)} | sha256sum -c -`,
    "chmod +x pimpmykali.sh",
    runCommand(),
    "echo PEH_STARTED",
  ].join("\n");
}
const POLL = pollScript();

export function pimpmykaliStep(sys: Sys, pin: Pin, opts: { bootTimeoutMs?: number; runTimeoutMs?: number; pollMs?: number } = {}): Step {
  const sleep = sys.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = opts.pollMs ?? 20_000, bootTimeout = opts.bootTimeoutMs ?? 6 * 60_000, runTimeout = opts.runTimeoutMs ?? 75 * 60_000;
  return {
    id: "pimpmykali",
    ...STEP_INFO.pimpmykali,
    async run({ progress, signal }) {
      if (sys.platform !== "win32") fail("PMK-OS", "This installer only works on Windows.", "Run PEH Lab Setup on your Windows PC.");
      const marker = join(sys.cacheDir, PMK_DONE);
      if (existsSync(marker)) { progress(1); return; } // ISC-30 re-runs skip

      const list = await vm(sys, ["list", "vms"]);
      if (!list.stdout.includes(`"${KALI_VM_NAME}"`)) fail("PMK-NOVM", "Kali isn't set up yet, so it can't be fixed up.", "Press Try again. Setup creates Kali first.");

      // ISC-27: boot with no window, wait for the guest tools to answer.
      const before = await vmState(sys);
      if (before !== "running") {
        let r = await vm(sys, ["startvm", KALI_VM_NAME, "--type", "headless"]);
        // ISC-56: a state saved under a different VirtualBox engine (Hyper-V vs VT-x) can't be restored;
        // the install has nothing worth keeping in RAM, so discard it once and boot fresh.
        if (r.code !== 0 && before.includes("saved")) {
          await vm(sys, ["discardstate", KALI_VM_NAME]);
          r = await vm(sys, ["startvm", KALI_VM_NAME, "--type", "headless"]);
        }
        if (r.code !== 0) fail("PMK-START", "Kali couldn't be started.", "Restart your PC, open PEH Lab Setup, and press Try again.", errText(r)); // ISC-55
      }
      const bootPolls = Math.max(1, Math.ceil(bootTimeout / 5000));
      let ready = false, lastErr = "";
      for (let i = 0; i < bootPolls && !ready; i++) {
        if (signal.aborted) throw new Error("stopped");
        const probe = await guest(sys, "true");
        ready = probe.code === 0;
        if (!ready) lastErr = errText(probe);
        if (!ready) { progress(0.1 * (i + 1) / bootPolls); await sleep(5000); }
      }
      if (!ready) fail("PMK-BOOT", "Kali started but didn't finish booting in time.", "Restart your PC, open PEH Lab Setup, and press Try again.", lastErr);
      progress(0.1);

      // ISC-26, ISC-28: pinned, checked, detached, as root.
      const launch = await guest(sys, launchScript(pin));
      if (launch.code !== 0 || !launch.stdout.includes("PEH_STARTED")) {
        const damaged = /FAILED|checksum/i.test(launch.stdout + launch.stderr);
        fail(damaged ? "PMK-SHA" : "PMK-DL", damaged ? "The Kali fixes download was damaged, so it didn't run." : "Kali couldn't download the course fixes.", "Check that you're online, then press Try again.", errText(launch));
      }

      // ISC-28, ISC-29: watch the log; ride out guest-tools dropouts.
      const maxPolls = Math.ceil(runTimeout / pollMs);
      let tail = "", drops = 0, lastErr2 = "";
      for (let i = 0; ; i++) {
        if (signal.aborted) throw new Error("stopped");
        if (i >= maxPolls) fail("PMK-TIMEOUT", "The Kali fixes took much longer than expected.", "Press Try again. It picks up where it left off.");
        await sleep(pollMs);
        const r = await guest(sys, POLL);
        if (r.code !== 0) { lastErr2 = errText(r); if (++drops > 30) fail("PMK-LOST", "We lost touch with Kali while it was being fixed up.", "Restart your PC, open PEH Lab Setup, and press Try again.", lastErr2); continue; }
        tail = r.stdout;
        progress(Math.min(0.85, 0.1 + 0.75 * (i + 1) / Math.max(1, (15 * 60_000) / pollMs)));
        if (tail.includes("PEH_STOPPED")) break;
      }
      if (!tail.includes(SUCCESS)) fail("PMK-FAIL", "The Kali fixes stopped before finishing.", "Press Try again. If it fails twice, copy the help bundle and post it in the support channel.", tail.replace(/PEH_STOPPED\s*$/, "").trim().slice(-600));
      progress(0.9);

      // ISC-30: clean shutdown (PimpMyKali asks for a reboot), hard power-off as a fallback.
      await vm(sys, ["controlvm", KALI_VM_NAME, "acpipowerbutton"]);
      let off = false;
      for (let i = 0; i < 36 && !off; i++) { await sleep(5000); off = (await vmState(sys)) === "poweroff"; }
      if (!off) await vm(sys, ["controlvm", KALI_VM_NAME, "poweroff"]);
      // ISC-54: Kali may have been running at import, which leaves its settings to now. VirtualBox can hold the
      // machine lock for a few seconds after power-off, so a refused change is tried again.
      for (let i = 0; ; i++) {
        try { await applyKaliSettings(sys); break; }
        catch (e) { if (i >= 5) throw e; await sleep(5000); }
      }
      mkdirSync(sys.cacheDir, { recursive: true });
      writeFileSync(marker, `${pin.build}\n`);
      progress(1);
    },
  };
}
