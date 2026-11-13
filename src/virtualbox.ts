/**
 * Real "Install VirtualBox" step (F4). Everything the machine does goes through `Sys`, so the
 * step is tested on any OS with a fake Windows and runs for real only on Windows.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { downloadResumable, sha256File } from "./download";
import type { Pin } from "./pins";
import { STEP_INFO, type Step, type StepFailure, type StepQuestion } from "./steps";

export interface Sys {
  platform: string;
  env: Record<string, string | undefined>;
  cacheDir: string;
  /** Where VBoxManage.exe lives when VirtualBox is installed, else null. */
  vboxManagePath(): string | null;
  exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  fetch: typeof fetch;
  /** Installed memory in GB (defaults to this PC's). */
  ramGb?: number;
  /** Waits between polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export function realSys(cacheDir: string): Sys {
  const env = process.env;
  return {
    platform: process.platform,
    env,
    cacheDir,
    vboxManagePath() {
      const dirs = [env.VBOX_MSI_INSTALL_PATH, env.ProgramFiles && join(env.ProgramFiles, "Oracle", "VirtualBox"), "C:\\Program Files\\Oracle\\VirtualBox"].filter(Boolean) as string[];
      for (const d of dirs) { const p = join(d, "VBoxManage.exe"); if (existsSync(p)) return p; }
      return null;
    },
    async exec(argv) {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    },
    fetch,
  };
}

const fail = (code: string, what: string, todo: string): never => { throw Object.assign(new Error(what), { failure: { code, what, todo } satisfies StepFailure }); };

/** "7.2.22r175245" → [7,2,22]; null when unreadable. */
export function parseVersion(s: string): number[] | null {
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}
const atLeast = (have: number[], want: number[]) => { for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i]; return true; };

async function installedVersion(sys: Sys): Promise<number[] | null> {
  const exe = sys.vboxManagePath();
  if (!exe) return null;
  const r = await sys.exec([exe, "--version"]);
  return r.code === 0 ? parseVersion(r.stdout) : null;
}

const ask = (q: StepQuestion): never => { throw Object.assign(new Error(q.what), { question: q }); };

/** Names of the VMs running right now ("Name" {uuid} per line). */
async function runningVms(sys: Sys, exe: string): Promise<string[]> {
  const r = await sys.exec([exe, "list", "runningvms"]);
  return r.code === 0 ? [...r.stdout.matchAll(/^"(.+)" \{[0-9a-f-]+\}\s*$/gim)].map((m) => m[1]!) : [];
}

/**
 * An older VirtualBox is upgraded only after the student says yes, and never while a VM runs (ISC-46..48).
 * Keeping the old version is not offered: the PimpMyKali step relies on 7.2 behaviour (ISC-43).
 */
async function confirmUpgrade(sys: Sys, have: number[], pin: Pin, confirmed: boolean): Promise<void> {
  const exe = sys.vboxManagePath()!;
  const from = have.join("."), running = await runningVms(sys, exe);
  const pack = /Extension Packs:\s*[1-9]/.test((await sys.exec([exe, "list", "extpacks"])).stdout) ? " Your Extension Pack will need updating to match afterwards." : "";
  const kept = `Your virtual machines are kept.${pack}`;
  if (running.length) ask({ code: "VBOX-RUNNING", what: `You have VirtualBox ${from}, and setup needs to upgrade it to ${pin.version}, but these virtual machines are running: ${running.join(", ")}.`, todo: `Shut them down in VirtualBox first (save your work inside them), then press the button. ${kept}`, confirm: "They're shut down, upgrade VirtualBox" });
  if (!confirmed) ask({ code: "VBOX-UPGRADE", what: `You have VirtualBox ${from}. Setup needs ${pin.version} or newer, so it will upgrade it.`, todo: kept, confirm: "Upgrade VirtualBox" });
}

/** PowerShell single-quoted literal. */
const psq = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function installerCommand(installer: string): string[] {
  const args = ["--silent", "--ignore-reboot", "--msiparams", "ADDLOCAL=VBoxApplication,VBoxUSB,VBoxNetwork", "VBOX_START=0", "VBOX_INSTALLQUICKLAUNCHSHORTCUT=0"];
  // One Windows permission prompt; -PassThru gives the installer's exit code. 3010 = done, restart later.
  const script = `$p = Start-Process -FilePath ${psq(installer)} -ArgumentList ${args.map(psq).join(",")} -Verb RunAs -Wait -PassThru; Write-Output $p.ExitCode; if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { exit 0 } else { exit 1 }`;
  return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script];
}

export function virtualboxStep(sys: Sys, pin: Pin): Step {
  return {
    id: "virtualbox",
    ...STEP_INFO.virtualbox,
    async run({ progress, signal, confirmed }) {
      if (sys.platform !== "win32") fail("VBOX-OS", "This installer only works on Windows.", "Run PEH Lab Setup on your Windows PC.");
      const want = parseVersion(pin.version)!;
      const have = await installedVersion(sys);
      if (have && atLeast(have, want)) { progress(1); return; } // ISC-14
      if (have) await confirmUpgrade(sys, have, pin, confirmed === true); // ISC-46..48
      progress(0.02);

      mkdirSync(sys.cacheDir, { recursive: true });
      const dest = join(sys.cacheDir, pin.file);
      if (!(existsSync(dest) && (await sha256File(dest)) === pin.sha256)) {
        rmSync(dest, { force: true });
        await downloadResumable(sys, pin.url, dest, { signal, code: "VBOX-DL", label: "VirtualBox", progress: (f) => progress(0.02 + 0.68 * f) }); // ISC-38..40
        if ((await sha256File(dest)) !== pin.sha256) { // ISC-15
          rmSync(dest, { force: true });
          fail("VBOX-SHA", "The VirtualBox download was damaged on the way, so we threw it away.", "Press Try again to download a fresh copy.");
        }
      }
      progress(0.75);

      const r = await sys.exec(installerCommand(dest)); // ISC-16
      const out = `${r.stdout}\n${r.stderr}`;
      if (r.code !== 0) {
        if (/cancel+ed by the user|1223/i.test(out)) fail("VBOX-UAC", "Windows asked for permission to install VirtualBox, and it wasn't given.", "Press Try again, then click Yes when Windows asks."); // ISC-17
        const exitCode = out.match(/^\s*(\d+)\s*$/m)?.[1] ?? "unknown";
        fail("VBOX-INSTALL", `The VirtualBox installer stopped with code ${exitCode}.`, "Restart your PC, open PEH Lab Setup, and press Try again. If it fails again, copy the help bundle.");
      }
      progress(0.95);

      const after = await installedVersion(sys); // ISC-18
      if (!after || !atLeast(after, want)) fail("VBOX-VERIFY", "VirtualBox finished installing but doesn't answer yet.", "Restart your PC, then open PEH Lab Setup again. It picks up where it left off.");
      progress(1);
    },
  };
}
