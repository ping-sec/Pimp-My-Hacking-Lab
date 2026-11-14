/**
 * Real "Install VirtualBox" step (F4). Everything the machine does goes through `Sys`, so the
 * step is tested on any OS with a fake Windows and runs for real only on Windows.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { downloadResumable, sha256File } from "./download";
import type { Pin } from "./pins";
import { STEP_INFO, type Step, type StepFailure, type StepQuestion } from "./steps";

export interface Sys {
  platform: string;
  env: Record<string, string | undefined>;
  cacheDir: string;
  /** Where VBoxManage.exe lives when VirtualBox is installed, else null. */
  vboxManagePath(): string | null;
  /** The folders the last lookup searched, for the help bundle (ISC-58). */
  vboxSearched?(): string[];
  /** What VirtualBox's host-only network driver lacks (ISC-62): nothing, its files, or its Windows driver-store entry. Absent means "ok". */
  hostOnlyDriver?(): "ok" | "files" | "store";
  exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  fetch: typeof fetch;
  /** Installed memory in GB (defaults to this PC's). */
  ramGb?: number;
  /** Waits between polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** VirtualBox's own record of where it is installed (HKLM\SOFTWARE\Oracle\VirtualBox InstallDir); null when absent. */
function registryInstallDir(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const r = Bun.spawnSync(["reg", "query", "HKLM\\SOFTWARE\\Oracle\\VirtualBox", "/v", "InstallDir"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    return r.stdout.toString().match(/InstallDir\s+REG_\w+\s+(.+?)\s*$/m)?.[1] ?? null;
  } catch { return null; }
}

export function realSys(cacheDir: string, o: { env?: Record<string, string | undefined>; regInstallDir?: () => string | null } = {}): Sys {
  const env = o.env ?? process.env;
  const reg = o.regInstallDir ?? registryInstallDir;
  let found: string | null = null, searched: string[] = [];
  const vboxManagePath = () => {
    if (found) return found; // ISC-58: kept for the run once found
    searched = [...new Set([reg(), env.VBOX_MSI_INSTALL_PATH, env.ProgramFiles && join(env.ProgramFiles, "Oracle", "VirtualBox"), "C:\\Program Files\\Oracle\\VirtualBox"].filter(Boolean) as string[])];
    for (const d of searched) { const p = join(d, "VBoxManage.exe"); if (existsSync(p)) return (found = p); }
    return null;
  };
  return {
    platform: process.platform,
    env,
    cacheDir,
    vboxManagePath,
    vboxSearched: () => searched,
    // ISC-62: the VBoxNetworkAdp feature's key file (VBoxMergeNetAdp6.wxi), then the driver as Windows knows it.
    hostOnlyDriver() {
      const exe = vboxManagePath();
      if (!exe || !existsSync(join(dirname(exe), "drivers", "network", "netadp6", "VBoxNetAdp6.sys"))) return "files";
      const repo = join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "DriverStore", "FileRepository");
      try { return readdirSync(repo).some((n) => /^vboxnetadp6\.inf_/i.test(n)) ? "ok" : "store"; }
      catch { return "ok"; } // unreadable here: let KALI-NET speak instead of blocking
    },
    async exec(argv) {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    },
    fetch,
  };
}

// The detail is the tool's own evidence for the help bundle (ISC-45, ISC-55, ISC-62); dropping it left VBOX-NET silent.
const fail = (code: string, what: string, todo: string, detail?: string): never => { throw Object.assign(new Error(what), { failure: { code, what, todo, ...(detail ? { detail } : {}) } satisfies StepFailure }); };

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
  const args = ["--silent", "--ignore-reboot", "--msiparams", "ADDLOCAL=VBoxApplication,VBoxUSB,VBoxNetwork,VBoxNetworkFlt,VBoxNetworkAdp", "VBOX_START=0", "VBOX_INSTALLQUICKLAUNCHSHORTCUT=0"];
  // One Windows permission prompt; -PassThru gives the installer's exit code. 3010 = done, restart later.
  const script = `$p = Start-Process -FilePath ${psq(installer)} -ArgumentList ${args.map(psq).join(",")} -Verb RunAs -Wait -PassThru; Write-Output $p.ExitCode; if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { exit 0 } else { exit 1 }`;
  return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script];
}

/**
 * Registers VirtualBox's host-only driver with Windows from its install folder, behind one permission prompt (ISC-62).
 * An elevated process can't pipe its output back, so cmd writes pnputil's output to `outFile` for the help bundle.
 * The cmd line goes as one string: Windows PowerShell joins an -ArgumentList array without quoting its parts.
 */
export function pnputilCommand(vboxDir: string, outFile: string): string[] {
  const inf = win32.join(vboxDir, "drivers", "network", "netadp6", "VBoxNetAdp6.inf");
  const line = `/c pnputil /add-driver "${inf}" /install > "${outFile}" 2>&1`;
  const script = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${psq(line)} -Verb RunAs -Wait -PassThru; Write-Output $p.ExitCode; exit 0`;
  return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script];
}

export function virtualboxStep(sys: Sys, pin: Pin): Step {
  return {
    id: "virtualbox",
    ...STEP_INFO.virtualbox,
    async run({ progress, signal, confirmed, log }) {
      const say = log ?? (() => {});
      if (sys.platform !== "win32") fail("VBOX-OS", "This installer only works on Windows.", "Run PEH Lab Setup on your Windows PC.");
      const want = parseVersion(pin.version)!;
      const have = await installedVersion(sys);
      const current = !!have && atLeast(have, want);
      const driver = () => sys.hostOnlyDriver?.() ?? "ok"; // ISC-62
      say(`VirtualBox installed: ${have ? have.join(".") : "none"}; this setup uses ${pin.version}`);
      if (current && driver() === "ok") { say("VirtualBox is already up to date; skipping the install."); progress(1); return; } // ISC-14
      // ISC-62: the detail always says which check failed, so a bundle is never silent about it.
      const netFail = (extra = ""): never => fail("VBOX-NET", "VirtualBox is installed, but its private-network driver is missing.", "Open Windows Settings > Apps, choose Oracle VirtualBox > Modify, turn on Host-Only Networking, then press Try again.", `Driver check: ${driver()} (files = VBoxNetAdp6.sys missing; store = not in Windows' driver store). ${extra}`.trim());
      // ISC-62: the pinned installer can add missing driver files to the same version, never to a newer one.
      if (current && driver() === "files" && have!.join(".") !== want.join(".")) netFail();
      if (have && !current) await confirmUpgrade(sys, have, pin, confirmed === true); // ISC-46..48
      progress(0.02);
      if (!current || driver() === "files") await install();

      // ISC-62: VirtualBox installs the driver into Windows only on a first install (VirtualBox.wxs: NOT Installed),
      // so a driver whose files are present but unregistered is added with pnputil.
      if (driver() === "store") {
        say("Adding VirtualBox's private-network driver to Windows (Windows will ask for permission).");
        mkdirSync(sys.cacheDir, { recursive: true });
        const outFile = join(sys.cacheDir, "pnputil.txt");
        rmSync(outFile, { force: true });
        const r = await sys.exec(pnputilCommand(win32.dirname(sys.vboxManagePath()!), outFile));
        const out = `${r.stdout}\n${r.stderr}`;
        if (r.code !== 0 && /cancel+ed by the user|1223/i.test(out)) fail("VBOX-UAC", "Windows asked for permission to add VirtualBox's network driver, and it wasn't given.", "Press Try again, then click Yes when Windows asks.");
        const said = existsSync(outFile) ? readFileSync(outFile, "utf8").replace(/\s+/g, " ").trim() : "(no output file)";
        if (driver() !== "ok") netFail(`pnputil exit ${r.stdout.trim() || "unknown"}${r.stderr.trim() ? ` (${r.stderr.trim()})` : ""}: ${said}`.slice(0, 600));
      }
      if (driver() !== "ok") netFail();
      progress(1);

      async function install() {
        mkdirSync(sys.cacheDir, { recursive: true });
        const dest = join(sys.cacheDir, pin.file);
        if (!(existsSync(dest) && (await sha256File(dest)) === pin.sha256)) {
          rmSync(dest, { force: true });
          say(`Downloading VirtualBox ${pin.version} from Oracle.`);
          await downloadResumable(sys, pin.url, dest, { signal, log: say, code: "VBOX-DL", label: "VirtualBox", progress: (f) => progress(0.02 + 0.68 * f) }); // ISC-38..40
          say("VirtualBox download checked: SHA-256 matches.");
          if ((await sha256File(dest)) !== pin.sha256) { // ISC-15
            rmSync(dest, { force: true });
            fail("VBOX-SHA", "The VirtualBox download was damaged on the way, so we threw it away.", "Press Try again to download a fresh copy.");
          }
        }
        progress(0.75);

        say("Running the VirtualBox installer (Windows will ask for permission).");
        const r = await sys.exec(installerCommand(dest)); // ISC-16
        const out = `${r.stdout}\n${r.stderr}`;
        if (r.code !== 0) {
          if (/cancel+ed by the user|1223/i.test(out)) fail("VBOX-UAC", "Windows asked for permission to install VirtualBox, and it wasn't given.", "Press Try again, then click Yes when Windows asks."); // ISC-17
          const exitCode = out.match(/^\s*(\d+)\s*$/m)?.[1] ?? "unknown";
          fail("VBOX-INSTALL", `The VirtualBox installer stopped with code ${exitCode}.`, "Restart your PC, open PEH Lab Setup, and press Try again. If it fails again, copy the help bundle.", out.trim().slice(-600));
        }
        progress(0.95);

        const after = await installedVersion(sys); // ISC-18
        if (!after || !atLeast(after, want)) fail("VBOX-VERIFY", "VirtualBox finished installing but doesn't answer yet.", "Restart your PC, then open PEH Lab Setup again. It picks up where it left off.");
      }
    },
  };
}
