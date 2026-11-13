/**
 * Real "Download Kali Linux" and "Set up your Kali computer" steps (F5).
 * Download: pinned image + pinned 7zr.exe, both SHA-256 checked, then extracted.
 * Import: registers the image as "Kali (PEH)", sizes it to the PC, and gives it NAT plus a
 * host-only lab network. It is never bridged to the home network (ISC-24).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, join } from "node:path";
import { downloadResumable, sha256File } from "./download";
import type { Pin } from "./pins";
import { STEP_INFO, type Step, type StepFailure } from "./steps";
import type { Sys } from "./virtualbox";

export const KALI_VM_NAME = "Kali (PEH)";
const fail = (code: string, what: string, todo: string, detail?: string): never => { throw Object.assign(new Error(what), { failure: { code, what, todo, ...(detail ? { detail } : {}) } satisfies StepFailure }); };

/** Download `pin` into the cache unless a verified copy is already there. Progress spans [from, to]. */
async function fetchVerified(sys: Sys, pin: Pin, codePrefix: string, label: string, progress: (f: number) => void, from: number, to: number, signal: AbortSignal): Promise<string> {
  mkdirSync(sys.cacheDir, { recursive: true });
  const dest = join(sys.cacheDir, pin.file);
  if (existsSync(dest) && (await sha256File(dest)) === pin.sha256) { progress(to); return dest; }
  rmSync(dest, { force: true });
  await downloadResumable(sys, pin.url, dest, { signal, code: `${codePrefix}-DL`, label, progress: (f) => progress(from + (to - from) * f) }); // ISC-38..40
  if ((await sha256File(dest)) !== pin.sha256) {
    rmSync(dest, { force: true });
    fail(`${codePrefix}-SHA`, `The ${label} download was damaged on the way, so we threw it away.`, "Press Try again to download a fresh copy.");
  }
  return dest;
}

const extractDir = (sys: Sys) => join(sys.cacheDir, "kali");
const DONE_MARK = ".extracted-ok";

/** The extracted Kali .vbox file, or null. */
export function findVbox(sys: Sys): string | null {
  const root = extractDir(sys);
  if (!existsSync(root)) return null;
  const walk = (d: string, depth: number): string | null => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".vbox")) return join(d, e.name);
      if (e.isDirectory() && depth > 0) { const hit = walk(join(d, e.name), depth - 1); if (hit) return hit; }
    }
    return null;
  };
  return walk(root, 2);
}

export function kaliDownloadStep(sys: Sys, kali: Pin, sevenzr: Pin): Step {
  return {
    id: "kali-download",
    ...STEP_INFO["kali-download"],
    async run({ progress, signal }) {
      if (sys.platform !== "win32") fail("KALI-OS", "This installer only works on Windows.", "Run PEH Lab Setup on your Windows PC.");
      if (existsSync(join(extractDir(sys), DONE_MARK)) && findVbox(sys)) { progress(1); return; } // ISC-21 reuse
      const archive = await fetchVerified(sys, kali, "KALI", "Kali Linux", progress, 0, 0.85, signal);
      const seven = await fetchVerified(sys, sevenzr, "KALI", "the 7-Zip extractor", progress, 0.85, 0.87, signal);
      rmSync(extractDir(sys), { recursive: true, force: true });
      mkdirSync(extractDir(sys), { recursive: true });
      const r = await sys.exec([seven, "x", "-y", `-o${extractDir(sys)}`, archive]); // ISC-22
      if (r.code !== 0 || !findVbox(sys)) {
        const full = /not enough space|disk full/i.test(r.stderr + r.stdout);
        fail("KALI-EXTRACT", full ? "Kali couldn't be unpacked because the disk is full." : "Kali downloaded fine but couldn't be unpacked.", "Free up about 30 GB of disk space, then press Try again.", (r.stderr || r.stdout).trim().slice(-600));
      }
      writeFileSync(join(extractDir(sys), DONE_MARK), kali.version);
      progress(1);
    },
  };
}

async function vbox(sys: Sys, args: string[], code: string, what: string): Promise<string> {
  const exe = sys.vboxManagePath();
  if (!exe) return fail("KALI-NOVBOX", "VirtualBox isn't installed yet, so Kali can't be set up.", "Press Try again. Setup installs VirtualBox first.");
  const r = await sys.exec([exe, ...args]);
  if (r.code !== 0) fail(code, what, "Restart your PC, open PEH Lab Setup, and press Try again. If it fails again, copy the help bundle.", (r.stderr || r.stdout).trim()); // ISC-45
  return r.stdout;
}
const hasVm = (list: string, name: string) => list.split("\n").some((l) => l.startsWith(`"${name}"`));

/** The host-only adapter for the private lab network, created on first use. */
async function hostOnlyAdapter(sys: Sys): Promise<string> {
  const list = await vbox(sys, ["list", "hostonlyifs"], "KALI-NET", "The private lab network couldn't be checked.");
  const existing = list.match(/^Name:\s+(.+)$/m)?.[1]?.trim();
  if (existing) return existing;
  const out = await vbox(sys, ["hostonlyif", "create"], "KALI-NET", "The private lab network couldn't be created.");
  const name = out.match(/Interface '(.+?)' was successfully created/)?.[1];
  if (!name) return fail("KALI-NET", "The private lab network couldn't be created.", "Restart your PC, open PEH Lab Setup, and press Try again.");
  await vbox(sys, ["hostonlyif", "ipconfig", name, "--ip", "192.168.56.1", "--netmask", "255.255.255.0"], "KALI-NET", "The private lab network couldn't be configured.");
  return name;
}

export function kaliImportStep(sys: Sys, kali: Pin): Step {
  return {
    id: "kali-import",
    ...STEP_INFO["kali-import"],
    async run({ progress }) {
      if (sys.platform !== "win32") fail("KALI-OS", "This installer only works on Windows.", "Run PEH Lab Setup on your Windows PC.");
      const before = await vbox(sys, ["list", "vms"], "KALI-IMPORT", "VirtualBox didn't answer.");
      if (hasVm(before, KALI_VM_NAME)) {
        // ISC-44: never re-register; finish a half-done import unless Kali is running right now.
        const info = await vbox(sys, ["showvminfo", KALI_VM_NAME, "--machinereadable"], "KALI-IMPORT", "VirtualBox couldn't read Kali's settings.");
        if (/^VMState="running"/m.test(info)) { progress(1); return; }
      } else {
        const file = findVbox(sys);
        if (!file) return fail("KALI-MISSING", "The Kali files are missing, so there's nothing to set up yet.", "Press Try again. Setup downloads Kali first.");
        const original = basename(file, ".vbox");
        progress(0.1);
        if (!hasVm(before, original)) await vbox(sys, ["registervm", file], "KALI-IMPORT", "Kali couldn't be added to VirtualBox.");
        await vbox(sys, ["modifyvm", original, "--name", KALI_VM_NAME], "KALI-IMPORT", "Kali couldn't be renamed in VirtualBox.");
      }
      progress(0.4);
      const adapter = await hostOnlyAdapter(sys);
      progress(0.6);
      const ramGb = sys.ramGb ?? totalmem() / 1024 ** 3;
      const memory = ramGb >= 15 ? 4096 : 2048;
      await vbox(sys, ["modifyvm", KALI_VM_NAME, "--memory", String(memory), "--cpus", "2", "--nic1", "nat", "--nic2", "hostonly", "--hostonlyadapter2", adapter], "KALI-IMPORT", "Kali's memory and network couldn't be set."); // ISC-23, ISC-24
      progress(0.9);
      const after = await vbox(sys, ["list", "vms"], "KALI-IMPORT", "VirtualBox didn't answer.");
      if (!hasVm(after, KALI_VM_NAME)) fail("KALI-VERIFY", "Kali was set up but VirtualBox doesn't list it.", "Restart your PC, open PEH Lab Setup, and press Try again.");
      progress(1);
    },
  };
}
