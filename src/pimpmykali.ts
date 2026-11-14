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
/** PimpMyKali and the guest-tools cleanup both succeeded (ISC-62). */
export const PMK_RAN = "pimpmykali.ran";
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
  throw Object.assign(new Error("no VirtualBox"), { failure: { code: "PMK-NOVBOX", what: "VirtualBox isn't on this PC anymore, so Kali can't be fixed up.", todo: "Press Try again. Setup installs VirtualBox again first.", redo: "virtualbox", detail: `Looked for VBoxManage.exe in: ${(sys.vboxSearched?.() ?? []).join("; ") || "nowhere"}` } satisfies StepFailure }); // ISC-57, ISC-58
}
async function vm(sys: Sys, args: string[]) { return sys.exec([manage(sys), ...args]); }
async function vmState(sys: Sys): Promise<string> {
  const r = await vm(sys, ["showvminfo", KALI_VM_NAME, "--machinereadable"]);
  return r.stdout.match(/^VMState="([^"]+)"/m)?.[1] ?? "unknown";
}
/** One bash command inside Kali; the script is always the last argument. VirtualBox 7.2 passes
 *  everything after "--" as argv[1..], so argv[0] is never repeated there (ISC-43). */
async function guest(sys: Sys, script: string) {
  const run = () => vm(sys, ["guestcontrol", KALI_VM_NAME, "run", "--username", GUEST_USER, "--password", GUEST_PASS, "--exe", "/bin/bash", "--", "-c", script]);
  const r = await run();
  if (r.code === 0 || !/VERR_DUPLICATE/.test(r.stderr + r.stdout)) return r;
  // ISC-59: VirtualBox already holds a guest session with the ID it just handed out; clear them all, try once more.
  await vm(sys, ["guestcontrol", KALI_VM_NAME, "closesession", "--all"]);
  return run();
}
/** Guest Additions run level from showvminfo, which opens no guest session (ISC-59). */
async function runLevel(sys: Sys): Promise<number> {
  const r = await vm(sys, ["showvminfo", KALI_VM_NAME, "--machinereadable"]);
  return Number(r.stdout.match(/^GuestAdditionsRunLevel=(\d+)/m)?.[1] ?? 0);
}
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Where the guest-tools cleanup looks and writes; tests point these at a temp dir. */
export interface GaPaths { opt: string; log: string }
const GA_PATHS: GaPaths = { opt: "/opt", log: "/home/kali/peh-guest-tools.log" };

/**
 * ISC-60: PimpMyKali's `fix_virtualbox` installs Oracle's guest additions over Kali's own packages, which leaves
 * Oracle's VBoxService on a kernel driver it didn't build and breaks guest control, mid-run or after the next boot.
 * This puts Kali back on its own packages: the exact commands that fixed it on a real Kali. It runs as root inside
 * the PimpMyKali job, right after PimpMyKali exits, so it never depends on the guest control it is repairing.
 */
export function guestToolsScript(o: GaPaths = GA_PATHS): string {
  const oracle = `${o.opt}/VBoxGuestAdditions-*`;
  return [
    `if ls -d ${oracle} >/dev/null 2>&1; then found=1`,
    `  for u in ${oracle}/uninstall.sh; do [ -x "$u" ] && yes | "$u"; done`,
    `  DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y virtualbox-guest-utils virtualbox-guest-x11; rc=$?`,
    `else found=0; rc=0; echo PEH_GA_SKIPPED; fi`,
    `if ls -d ${oracle} >/dev/null 2>&1; then left=1; else left=0; fi`,
    `echo "PEH_GA_DONE rc=$rc left=$left"`,
    // ISC-61: Kali's guest service only starts cleanly on Kali's own driver after a reboot ("Could not execute systemctl").
    `if [ "$found" = 1 ]; then sync; sleep 3; reboot; fi`,
  ].join("\n");
}
/** The cleanup's log once it has finished, else PEH_GA_WAIT. */
export function gaPollScript(o: GaPaths = GA_PATHS): string {
  return `if grep -q '^PEH_GA_DONE' ${sh(o.log)} 2>/dev/null; then tail -n 20 ${sh(o.log)}; else echo PEH_GA_WAIT; fi`;
}

/**
 * Starts PimpMyKali detached as root and records its PID (ISC-28, ISC-53). PimpMyKali reads its user from
 * `logname`, which is empty without a login session, so this run gets a `logname` that answers the guest user
 * from a shim directory first on its PATH; the shim is removed when the run ends (ISC-52). When PimpMyKali exits,
 * success or not, the same job tidies the guest tools into their own log (ISC-60).
 */
export function runCommand(o: RunPaths = KALI_PATHS, ga: GaPaths = GA_PATHS): string {
  const path = `${o.shim}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const inner = [
    `echo ${GUEST_PASS} | sudo -S env PATH=${sh(path)} ./pimpmykali.sh --autonoroot; rm -rf ${sh(o.shim)}`,
    `echo ${GUEST_PASS} | sudo -S sh -c ${sh(guestToolsScript(ga))} > ${sh(ga.log)} 2>&1`,
  ].join("\n");
  return [
    `cd ${sh(o.dir)}`,
    `rm -f ${sh(ga.log)}`,
    `mkdir -p ${sh(o.shim)} && printf '#!/bin/sh\\necho ${GUEST_USER}\\n' > ${sh(`${o.shim}/logname`)} && chmod 755 ${sh(`${o.shim}/logname`)}`,
    `nohup sh -c ${sh(inner)} > ${sh(o.log)} 2>&1 < /dev/null &`,
    `echo $! > ${sh(o.pid)}`,
  ].join("\n");
}

/** The log tail, then whether the recorded PID is still alive; a command-line match would find the poll itself (ISC-53). */
export function pollScript(o: Pick<RunPaths, "log" | "pid"> = KALI_PATHS, ga: GaPaths = GA_PATHS): string {
  // ISC-61: the cleanup's result is the job's last act, so once it exists the job is over, whatever owns the old PID now.
  return `tail -c 3000 ${sh(o.log)} 2>/dev/null; p=$(cat ${sh(o.pid)} 2>/dev/null); if grep -q '^PEH_GA_DONE' ${sh(ga.log)} 2>/dev/null; then echo PEH_STOPPED; elif [ -n "$p" ] && [ -d "/proc/$p" ]; then echo PEH_RUNNING; else echo PEH_STOPPED; fi`;
}

/**
 * The lines of a log poll the student hasn't seen yet (ISC-66). The poll returns the log's last 3000 bytes, so
 * consecutive polls overlap: the new window starts with lines from the end of the last one. Colour codes and our
 * own PEH_ markers are dropped, a \r-redrawn line keeps its final state, and a first line cut by `tail -c` is skipped.
 */
export function newLogLines(seen: string[], out: string, cut: boolean): { lines: string[]; seen: string[] } {
  let cur = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => (l.split("\r").filter((x) => x.trim()).at(-1) ?? "").trimEnd());
  if (cut) cur = cur.slice(1);
  cur = cur.filter((l) => l.trim() && !/^PEH_(RUNNING|STOPPED)$/.test(l.trim()));
  let j = Math.min(seen.length, cur.length);
  for (; j > 0; j--) {
    let same = true;
    for (let k = 0; k < j && same; k++) same = cur[k] === seen[seen.length - j + k];
    if (same) break;
  }
  return { lines: cur.slice(j), seen: cur };
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
    async run({ progress, signal, log }) {
      const say = log ?? (() => {});
      if (sys.platform !== "win32") fail("PMK-OS", "This installer only works on Windows.", "Run PEH Lab Setup on your Windows PC.");
      const marker = join(sys.cacheDir, PMK_DONE);
      if (existsSync(marker)) { say("The Kali fixes already ran; skipping."); progress(1); return; } // ISC-30 re-runs skip

      const list = await vm(sys, ["list", "vms"]);
      if (!list.stdout.includes(`"${KALI_VM_NAME}"`)) fail("PMK-NOVM", "Kali isn't set up yet, so it can't be fixed up.", "Press Try again. Setup creates Kali first.");

      // ISC-62: once PimpMyKali and the cleanup have succeeded, a Try again goes straight to the shutdown and settings.
      const ran = join(sys.cacheDir, PMK_RAN);
      if (!existsSync(ran)) {
        // ISC-27: boot with no window, wait for the guest tools to answer.
        const before = await vmState(sys);
        if (before !== "running") {
          say("Starting Kali in the background (no window).");
          let r = await vm(sys, ["startvm", KALI_VM_NAME, "--type", "headless"]);
          // ISC-56: a state saved under a different VirtualBox engine (Hyper-V vs VT-x) can't be restored;
          // the install has nothing worth keeping in RAM, so discard it once and boot fresh.
          if (r.code !== 0 && before.includes("saved")) {
            say("Kali's saved state wouldn't restore; discarding it and starting fresh.");
            await vm(sys, ["discardstate", KALI_VM_NAME]);
            r = await vm(sys, ["startvm", KALI_VM_NAME, "--type", "headless"]);
          }
          if (r.code !== 0) fail("PMK-START", "Kali couldn't be started.", "Restart your PC, open PEH Lab Setup, and press Try again.", errText(r)); // ISC-55
        }
        say("Waiting for Kali to finish booting.");
        const bootPolls = Math.max(1, Math.ceil(bootTimeout / 5000));
        let ready = false, lastErr = "";
        for (let i = 0; i < bootPolls && !ready; i++) {
          if (signal.aborted) throw new Error("stopped");
          const level = await runLevel(sys);
          if (level < 2) { lastErr = `Guest Additions run level ${level} (needs 2)`; progress(0.1 * (i + 1) / bootPolls); await sleep(5000); continue; } // ISC-59
          const probe = await guest(sys, "true");
          ready = probe.code === 0;
          if (!ready) lastErr = errText(probe);
          if (!ready) { progress(0.1 * (i + 1) / bootPolls); await sleep(5000); }
        }
        if (!ready) fail("PMK-BOOT", "Kali started but didn't finish booting in time.", "Restart your PC, open PEH Lab Setup, and press Try again.", lastErr);
        progress(0.1);
        say("Kali is up. Downloading PimpMyKali inside Kali and checking its SHA-256.");

        // ISC-26, ISC-28: pinned, checked, detached, as root.
        const launch = await guest(sys, launchScript(pin));
        if (launch.code !== 0 || !launch.stdout.includes("PEH_STARTED")) {
          const damaged = /FAILED|checksum/i.test(launch.stdout + launch.stderr);
          fail(damaged ? "PMK-SHA" : "PMK-DL", damaged ? "The Kali fixes download was damaged, so it didn't run." : "Kali couldn't download the course fixes.", "Check that you're online, then press Try again.", errText(launch));
        }

        say("PimpMyKali is running. Its own output follows.");
        // ISC-28, ISC-29: watch the log; ride out guest-tools dropouts.
        const maxPolls = Math.ceil(runTimeout / pollMs);
        let tail = "", drops = 0, lastErr2 = "", seenLines: string[] = [], down = false;
        for (let i = 0; ; i++) {
          if (signal.aborted) throw new Error("stopped");
          if (i >= maxPolls) fail("PMK-TIMEOUT", "The Kali fixes took much longer than expected.", "Press Try again. It picks up where it left off.");
          await sleep(pollMs);
          const r = await guest(sys, POLL);
          // ISC-60: guest control can stay down until the in-job cleanup restores Kali's guest tools; ride out 40 minutes.
          if (r.code !== 0) { if (!down) say("Lost touch with Kali for a moment (expected while its guest tools reinstall); still waiting."); down = true; lastErr2 = errText(r); if (++drops > (40 * 60_000) / pollMs) fail("PMK-LOST", "We lost touch with Kali while it was being fixed up.", "Restart your PC, open PEH Lab Setup, and press Try again.", lastErr2); continue; }
          tail = r.stdout;
          if (down) say("Back in touch with Kali.");
          down = false;
          const logPart = tail.replace(/PEH_(RUNNING|STOPPED)\s*$/, "");
          const fresh = newLogLines(seenLines, logPart, logPart.length >= 2990); // ISC-66
          seenLines = fresh.seen;
          for (const l of fresh.lines) say(l);
          progress(Math.min(0.85, 0.1 + 0.75 * (i + 1) / Math.max(1, (15 * 60_000) / pollMs)));
          if (tail.includes("PEH_STOPPED")) break;
        }
        if (!tail.includes(SUCCESS)) fail("PMK-FAIL", "The Kali fixes stopped before finishing.", "Press Try again. If it fails twice, copy the help bundle and post it in the support channel.", tail.replace(/PEH_STOPPED\s*$/, "").trim().slice(-600));
        progress(0.88);
        say("PimpMyKali finished. Checking the guest-tools cleanup inside Kali.");

        // ISC-60: the PimpMyKali job has already tidied the guest tools; read its result before the shutdown.
        const gaFail = (detail: string): never => fail("PMK-GA", "Kali's guest tools couldn't be tidied up after the fixes.", "Check that you're online, then press Try again.", detail);
        let gaOut = "", gaErr = "";
        for (let i = 0; i < 15 && !gaOut; i++) {
          if (signal.aborted) throw new Error("stopped");
          const r = await guest(sys, gaPollScript());
          if (r.code === 0 && r.stdout.includes("PEH_GA_DONE")) gaOut = r.stdout;
          else { gaErr = r.code === 0 ? r.stdout : errText(r); await sleep(pollMs); }
        }
        if (!gaOut) gaFail(gaErr || "The guest tools cleanup left no result.");
        if (!/PEH_GA_DONE rc=0 left=0/.test(gaOut)) gaFail(gaOut.trim().slice(-600));
        say("Guest tools tidied up.");
        progress(0.9);
        mkdirSync(sys.cacheDir, { recursive: true });
        writeFileSync(ran, `${pin.build}\n`);
      }

      // ISC-30: clean shutdown (PimpMyKali asks for a reboot), hard power-off as a fallback. A Try again may find it off already.
      if ((await vmState(sys)) === "running") {
        say("Shutting Kali down cleanly.");
        await vm(sys, ["controlvm", KALI_VM_NAME, "acpipowerbutton"]);
        let off = false;
        for (let i = 0; i < 36 && !off; i++) { await sleep(5000); off = (await vmState(sys)) === "poweroff"; }
        if (!off) { say("Kali didn't shut down in 3 minutes; powering it off."); await vm(sys, ["controlvm", KALI_VM_NAME, "poweroff"]); }
      }
      say("Applying Kali's memory, CPUs and network settings.");
      // ISC-54: Kali may have been running at import, which leaves its settings to now. VirtualBox can hold the
      // machine lock for a few seconds after power-off, so a refused change is tried again. A network failure is
      // never retried: creating the adapter asks Windows for permission each time (ISC-62).
      for (let i = 0; ; i++) {
        try { await applyKaliSettings(sys); break; }
        catch (e) { if (i >= 5 || (e as { failure?: StepFailure }).failure?.code === "KALI-NET") throw e; await sleep(5000); }
      }
      mkdirSync(sys.cacheDir, { recursive: true });
      writeFileSync(marker, `${pin.build}\n`);
      progress(1);
    },
  };
}
