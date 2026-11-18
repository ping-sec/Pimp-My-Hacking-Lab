/**
 * Ubuntu 24.04 host support (F14): what this PC is, and the real "Install VirtualBox" step on Linux.
 *
 * Facts this rests on (read from source 2026-11-17, see ISA F14):
 * - Oracle's noble .deb runs vboxdrv.sh from postinst. On Secure Boot it signs its modules with
 *   Ubuntu's shim MOK key (/var/lib/shim-signed/mok/MOK.der); the key works only once enrolled at
 *   the MokManager screen after a restart.
 * - Ubuntu's update-secureboot-policy does nothing non-interactively and skips a key whose
 *   enrollment is already requested, so the password this step sets is the one MokManager asks for.
 * - VirtualBox 7.2.22 shares VT-x with KVM only on kernels 6.16+ (SUPDrv-linux.c:93); on 6.12–6.15
 *   KVM grabs VT-x when it loads unless `kvm enable_virt_at_load=0`.
 */
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { downloadResumable, sha256File } from "./download";
import type { Pin } from "./pins";
import { stepInfo, type Step, type StepFailure, type StepQuestion } from "./steps";
import { atLeast, confirmUpgrade, installedVersion, parseVersion, type Sys } from "./virtualbox";

export const MOK_DIR = "/var/lib/shim-signed/mok";
export const KVM_CONF = "/etc/modprobe.d/peh-lab-kvm.conf";
export const VBOX_MANAGE_PATHS = ["/usr/bin/VBoxManage", "/usr/lib/virtualbox/VBoxManage"];
const EFI_SECURE_BOOT = "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c";

export type MokState = "enrolled" | "pending" | "not-enrolled" | "no-key";

/** Everything the Linux step reads about this PC, so tests can fake a whole Ubuntu box. */
export interface LinuxHost {
  osRelease(): string;
  cpuinfo(): string;
  /** true/false from the EFI variable; null on a legacy-BIOS PC (no Secure Boot). */
  secureBoot(): boolean | null;
  kernel(): string;
  /** /sys/module/kvm/parameters/enable_virt_at_load; null when KVM isn't loaded or the kernel has no such option. */
  kvmVirtAtLoad(): boolean | null;
  hasVboxDrv(): boolean;
  /** Enrollment state of the MOK key, read from the public copy the root script leaves in the cache. */
  mokState(): Promise<MokState>;
  bootId(): string;
  setupLog(): string;
  /** Open this app again at the next login (on), or stop doing that (off). */
  resumeAtLogin(on: boolean): void;
}

export function realLinuxHost(sys: Sys, execPath = process.execPath): LinuxHost {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const autostart = join(homedir(), ".config", "autostart", "pimp-my-hacking-lab-resume.desktop");
  return {
    osRelease: () => read("/etc/os-release"),
    cpuinfo: () => read("/proc/cpuinfo"),
    secureBoot() {
      if (!existsSync("/sys/firmware/efi")) return null;
      try { const b = readFileSync(EFI_SECURE_BOOT); return b.length >= 5 ? b[4] === 1 : null; } catch { return false; }
    },
    kernel: () => release(),
    kvmVirtAtLoad() { const v = read("/sys/module/kvm/parameters/enable_virt_at_load").trim(); return v ? v === "Y" || v === "1" : null; },
    hasVboxDrv: () => existsSync("/dev/vboxdrv"),
    async mokState() {
      const copy = join(sys.cacheDir, "mok.der");
      if (!existsSync(copy)) return "no-key";
      const r = await sys.exec(["mokutil", "--test-key", copy]);
      return parseMokTest(`${r.stdout}\n${r.stderr}`);
    },
    bootId: () => read("/proc/sys/kernel/random/boot_id").trim(),
    setupLog: () => read("/var/log/vbox-setup.log"),
    resumeAtLogin(on) {
      try {
        if (!on) { rmSync(autostart, { force: true }); return; }
        mkdirSync(join(homedir(), ".config", "autostart"), { recursive: true });
        writeFileSync(autostart, ["[Desktop Entry]", "Type=Application", "Name=Pimp My Hacking Lab (finish setup)", `Exec="${execPath}"`, "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n"));
      } catch { /* a convenience: the question already says to open the app again */ }
    },
  };
}

/** mokutil --test-key wording (mokutil 0.6, the same strings vboxdrv.sh and update-secureboot-policy match). */
export function parseMokTest(out: string): MokState {
  if (/is already enrolled/i.test(out)) return "enrolled";
  if (/already in the enrollment request/i.test(out)) return "pending";
  if (/is not enrolled/i.test(out)) return "not-enrolled";
  return "no-key";
}

export function isUbuntu2404(osRelease: string): boolean {
  return /^ID=ubuntu$/m.test(osRelease) && /^VERSION_ID="?24\.04"?$/m.test(osRelease);
}
export function hasHardwareVirt(cpuinfo: string): boolean {
  return /^flags\s*:.*\b(vmx|svm)\b/m.test(cpuinfo);
}
/** Kernels 6.12 to 6.15, where KVM takes VT-x at load and VirtualBox 7.2.22 can't share it (ISC-72). */
export function kernelNeedsKvmOption(kernel: string): boolean {
  const m = kernel.match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj === 6 && min >= 12 && min <= 15;
}
export const kvmConflict = (h: LinuxHost) => kernelNeedsKvmOption(h.kernel()) && h.kvmVirtAtLoad() === true;

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface RootScriptOpts {
  /** The verified Oracle .deb, or null when VirtualBox is already current. */
  deb: string | null;
  cacheDir: string;
  /** Owner of the files left in the cache. */
  uid: number; gid: number;
  secureBoot: boolean;
  /** One-time MokManager password, 8 digits. */
  mokPassword: string;
  kvmFix: boolean;
  /** Tests point these at a temp dir. */
  mokDir?: string;
  kvmConf?: string;
}

/**
 * The one script that runs as root behind one pkexec prompt (ISC-69). Order matters: the MOK key
 * must exist before the .deb's postinst builds the modules, so vboxdrv.sh signs them with it.
 */
export function rootScript(o: RootScriptOpts): string {
  const k = o.mokDir ?? MOK_DIR, conf = o.kvmConf ?? KVM_CONF, cache = o.cacheDir;
  const lines = [
    "set -u",
    `CACHE=${sh(cache)}; K=${sh(k)}`,
    'say() { echo "PEH: $*"; }',
  ];
  if (o.secureBoot) lines.push( // ISC-70
    'if [ ! -f "$K/MOK.der" ] || [ ! -f "$K/MOK.priv" ]; then',
    '  if command -v update-secureboot-policy >/dev/null 2>&1 && update-secureboot-policy --help 2>&1 | grep -q new-key; then SHIM_NOTRIGGER=y update-secureboot-policy --new-key >/dev/null 2>&1; fi',
    '  if [ ! -f "$K/MOK.der" ] || [ ! -f "$K/MOK.priv" ]; then',
    '    mkdir -m 0700 -p "$K"',
    '    openssl req -nodes -new -x509 -newkey rsa:2048 -outform DER -addext "extendedKeyUsage=codeSigning" -subj "/CN=PEH Lab module signing/" -days 36500 -keyout "$K/MOK.priv" -out "$K/MOK.der" >/dev/null 2>&1 || { say "MOK_KEYGEN_FAILED"; exit 21; }',
    '  fi',
    '  say "MOK_KEY_CREATED"',
    'fi',
    `install -m 0644 -o ${o.uid} -g ${o.gid} "$K/MOK.der" "$CACHE/mok.der"`,
    'case "$(mokutil --test-key "$K/MOK.der" 2>&1)" in',
    '  *"already enrolled"*) say "MOK_ENROLLED" ;;',
    '  *"enrollment request"*) say "MOK_PENDING" ;;',
    // Ubuntu's own enroll_mok does exactly this: the password twice on stdin, then no MokManager timeout.
    `  *) if printf '%s\\n%s\\n' ${sh(o.mokPassword)} ${sh(o.mokPassword)} | mokutil --import "$K/MOK.der" >/dev/null 2>&1; then mokutil --timeout -1 >/dev/null 2>&1 || true; say "MOK_REQUESTED"; else say "MOK_IMPORT_FAILED"; exit 22; fi ;;`,
    'esac',
  );
  if (o.kvmFix) lines.push( // ISC-72
    `echo 'options kvm enable_virt_at_load=0' > ${sh(conf)}`,
    'if modprobe -r kvm_intel kvm_amd kvm >/dev/null 2>&1; then',
    '  if grep -qw vmx /proc/cpuinfo; then modprobe kvm_intel >/dev/null 2>&1; else modprobe kvm_amd >/dev/null 2>&1; fi',
    '  say "KVM_RELOADED"',
    'else say "KVM_IN_USE"; fi',
  );
  if (o.deb) lines.push( // ISC-68, ISC-69: Ubuntu's own 7zip extracts Kali (ISC-75)
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -q || true",
    // The .deb only Recommends generic headers; vboxdrv.sh builds for the running kernel, so ask for its own (best effort: a custom kernel has none).
    'apt-get install -y -q "linux-headers-$(uname -r)" || say "HEADERS_MISSING"',
    `apt-get install -y -q ${sh(o.deb)} 7zip || { say "APT_FAILED"; exit 23; }`,
    'say "APT_OK"',
  );
  lines.push('say "ROOT_DONE"');
  return lines.join("\n") + "\n";
}

const fail = (code: string, what: string, todo: string, detail?: string): never => { throw Object.assign(new Error(what), { failure: { code, what, todo, ...(detail ? { detail } : {}) } satisfies StepFailure }); };
const ask = (q: StepQuestion): never => { throw Object.assign(new Error(q.what), { question: q }); };

/** The kept one-time MokManager password, made on first use (ISC-70). */
export function mokPassword(cacheDir: string): string {
  const f = join(cacheDir, "mok-password.txt");
  try { const p = readFileSync(f, "utf8").trim(); if (/^\d{8}$/.test(p)) return p; } catch { /* make one */ }
  mkdirSync(cacheDir, { recursive: true });
  const p = Array.from({ length: 8 }, () => String(randomInt(10))).join("");
  writeFileSync(f, p, { mode: 0o600 });
  return p;
}

export const MOK_STEPS = (pw: string) => [
  "Press the button below. Your PC restarts.",
  "A blue screen says \"Perform MOK management\". Choose \"Enroll MOK\" with the arrow keys and press Enter.",
  "Choose \"Continue\", then \"Yes\".",
  `Type the password ${pw} and press Enter. Nothing shows while you type; that's normal.`,
  "Choose \"Reboot\". Ubuntu starts, and Pimp My Hacking Lab opens again by itself to finish.",
];

export function linuxVirtualboxStep(sys: Sys, host: LinuxHost, pin: Pin): Step {
  return {
    id: "virtualbox",
    ...stepInfo("linux").virtualbox,
    async run({ progress, signal, confirmed, answered, log }) {
      const say = log ?? (() => {});
      const said = (code: string) => answered?.includes(code) ?? false;
      if (sys.platform !== "linux") fail("LNX-OS", "This part of setup is for Ubuntu.", "Run the Windows version of Pimp My Hacking Lab on Windows.");
      const want = parseVersion(pin.version)!;
      const restartMark = join(sys.cacheDir, "restart-asked.boot");

      // ISC-71: restart only when the student pressed the button for a question asked during this boot.
      if (said("LNX-RESTART") && existsSync(restartMark) && readFileSync(restartMark, "utf8").trim() === host.bootId()) {
        say("Restarting the PC so the VirtualBox driver can load.");
        host.resumeAtLogin(true);
        const r = await sys.exec(["systemctl", "reboot"]);
        ask({ code: "LNX-RESTARTING", what: r.code === 0 ? "Your PC is restarting now." : "Ubuntu didn't restart by itself.", todo: "If it doesn't restart in a minute, restart it from the power menu in the top-right corner. Setup opens again after you log in.", confirm: "Check again" });
      }

      const have = await installedVersion(sys);
      const current = !!have && atLeast(have, want);
      const sb = host.secureBoot() === true;
      say(`VirtualBox installed: ${have ? have.join(".") : "none"}; this setup uses ${pin.version}. Secure Boot: ${sb ? "on" : "off"}. Kernel ${host.kernel()}.`);
      if (current && host.hasVboxDrv() && !kvmConflict(host)) { say("VirtualBox is already set up; skipping the install."); host.resumeAtLogin(false); progress(1); return; } // ISC-14

      if (have && !current) await confirmUpgrade(sys, have, pin, confirmed === true || said("VBOX-UPGRADE")); // ISC-46..48
      progress(0.02);

      const mok = sb ? await host.mokState() : "enrolled";
      const needRoot = !current || (sb && (mok === "not-enrolled" || mok === "no-key")) || kvmConflict(host);
      if (needRoot) {
        let deb: string | null = null;
        if (!current) {
          mkdirSync(sys.cacheDir, { recursive: true });
          deb = join(sys.cacheDir, pin.file);
          if (!(existsSync(deb) && (await sha256File(deb)) === pin.sha256)) {
            rmSync(deb, { force: true });
            say(`Downloading VirtualBox ${pin.version} from Oracle.`);
            await downloadResumable(sys, pin.url, deb, { signal, log: say, code: "VBOX-DL", label: "VirtualBox", progress: (f) => progress(0.02 + 0.58 * f) }); // ISC-38..40
            if ((await sha256File(deb)) !== pin.sha256) { rmSync(deb, { force: true }); fail("VBOX-SHA", "The VirtualBox download was damaged on the way, so we threw it away.", "Press Try again to download a fresh copy."); }
            say("VirtualBox download checked: SHA-256 matches.");
          }
        }
        progress(0.62);
        const script = join(sys.cacheDir, "root-setup.sh");
        mkdirSync(sys.cacheDir, { recursive: true });
        writeFileSync(script, rootScript({ deb, cacheDir: sys.cacheDir, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, secureBoot: sb, mokPassword: mokPassword(sys.cacheDir), kvmFix: kvmConflict(host) }), { mode: 0o600 });
        chmodSync(script, 0o600);
        say(deb ? "Installing VirtualBox (Ubuntu will ask for your password)." : "Finishing VirtualBox's setup (Ubuntu will ask for your password).");
        const r = await sys.exec(["pkexec", "/bin/bash", script]); // ISC-69
        rmSync(script, { force: true });
        const out = `${r.stdout}\n${r.stderr}`;
        for (const l of out.split("\n").filter((l) => l.startsWith("PEH: "))) say(l.slice(5));
        if (r.code === 126 || r.code === 127) fail("LNX-AUTH", "Ubuntu asked for your password to install VirtualBox, and it wasn't given.", "Press Try again, then type your password when Ubuntu asks.", out.trim().slice(-300));
        if (r.code !== 0 || !out.includes("PEH: ROOT_DONE")) {
          if (out.includes("APT_FAILED")) fail("LNX-APT", "Ubuntu couldn't install VirtualBox.", "Check that you're online and that Software Updater isn't running, then press Try again.", out.trim().slice(-600));
          fail("LNX-INSTALL", "VirtualBox's setup stopped before it finished.", "Restart your PC, open Pimp My Hacking Lab, and press Try again. If it fails again, copy the help bundle.", out.trim().slice(-600));
        }
      }
      progress(0.92);

      const after = await installedVersion(sys); // ISC-73
      if (!after || !atLeast(after, want)) fail("VBOX-VERIFY", "VirtualBox finished installing but doesn't answer yet.", "Restart your PC, then open Pimp My Hacking Lab again. It picks up where it left off.");
      if (host.hasVboxDrv() && !kvmConflict(host)) { rmSync(restartMark, { force: true }); host.resumeAtLogin(false); progress(1); return; }

      const mokNow = sb ? await host.mokState() : "enrolled";
      const enrollOwed = sb && mokNow === "pending";
      if (enrollOwed || kvmConflict(host)) { // ISC-71
        writeFileSync(restartMark, host.bootId());
        const pw = mokPassword(sys.cacheDir);
        return ask(enrollOwed
          ? { code: "LNX-RESTART", what: `VirtualBox is installed. Because Secure Boot is on, your PC has to approve VirtualBox's driver once, on a blue screen after a restart. Your one-time password is ${pw}. Write it down.`, todo: `Save anything you have open first. You'll need the password ${pw} on the blue screen.`, confirm: "Restart my PC", steps: MOK_STEPS(pw) }
          : { code: "LNX-RESTART", what: "VirtualBox is installed. Your PC needs one restart so VirtualBox can use virtualization.", todo: "Save anything you have open, then press the button. Pimp My Hacking Lab opens again by itself after you log in.", confirm: "Restart my PC" });
      }
      fail("LNX-DRIVER", "VirtualBox is installed, but its driver didn't start.", sb && mokNow !== "enrolled" ? "Press Try again. Setup asks Ubuntu to approve the driver again." : "Restart your PC, open Pimp My Hacking Lab, and press Try again. If it fails again, copy the help bundle.", host.setupLog().trim().slice(-600) || "no /var/log/vbox-setup.log");
    },
  };
}
