/**
 * Local installer server: serves the UI on 127.0.0.1 and exposes the install API.
 * State persists to disk so a reboot resumes the run (ISC-5).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, release, totalmem, userInfo } from "node:os";
import { dirname, join } from "node:path";
import uiHtml from "../ui/index.html" with { type: "text" };
import { PROFILES, STEP_INFO, planFor, simulatedStep, type ProfileId, type Step, type StepFailure, type StepId, type StepQuestion } from "./steps";
import { KALI, PIMPMYKALI, SEVENZR, VIRTUALBOX } from "./pins";
import { pimpmykaliStep } from "./pimpmykali";
import { IDLE_EXIT_MS, clearInstance, existingInstance, shouldExit, writeInstance } from "./lifecycle";
import { kaliDownloadStep, kaliImportStep } from "./kali";
import { realSys, virtualboxStep } from "./virtualbox";

export type Verdict = "pass" | "warn" | "fail" | "unknown";
export interface Check { id: "virtualization" | "ram" | "disk"; label: string; verdict: Verdict; value: string; advice: string }
export type StepState = "waiting" | "running" | "done" | "failed" | "needs-you";
export interface RunState {
  profile: ProfileId;
  plan: StepId[];
  steps: Record<string, { state: StepState; progress: number }>;
  status: "idle" | "running" | "failed" | "done";
  failure?: StepFailure & { step: StepId };
  /** A step waiting for the student's yes (ISC-49). */
  question?: StepQuestion & { step: StepId };
  /** Steps the student said yes to; kept across restarts. */
  confirmed?: StepId[];
  startedAt?: string;
  updatedAt?: string;
}

export interface Config {
  stateDir: string;
  downloadsDir: string;
  /** Pattern for the course's lab file name; the URL itself is never stored here. */
  labsFilePattern: RegExp;
  /** Expected SHA-256 of the lab file; null skips the check (to be filled from product). */
  labsSha256: string | null;
  labsPageUrl: string;
  msPerMinute: number;
  failAt?: StepId;
  /** Steps that run for real; every other step is simulated until it is built. */
  realSteps: Set<StepId>;
  /** Test hook: overrides the virtualization probe. */
  virtualizationProbe?: () => Promise<VirtReading>;
}

export function defaultConfig(): Config {
  const home = homedir();
  const stateDir = platform() === "win32" ? join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "PEHLab") : join(home, ".local", "state", "peh-lab");
  return {
    stateDir,
    downloadsDir: join(home, "Downloads"),
    labsFilePattern: /peh.*(web|lab).*\.(zip|7z|tar\.gz)$/i,
    labsSha256: null,
    labsPageUrl: "https://tcm-sec.com/academy/practical-ethical-hacking/",
    msPerMinute: Number(process.env.PEH_SIM_MS_PER_MIN ?? 400),
    realSteps: new Set(platform() === "win32" && !process.argv.includes("--simulate") ? ["virtualbox", "kali-download", "kali-import", "pimpmykali"] : []),
  };
}

// ── PC check (ISC-2, ISC-36, ISC-37) ──────────────────────────────────────
/**
 * Two readings, because one lies: VirtualizationFirmwareEnabled reads False whenever Windows
 * itself runs on its hypervisor (Hyper-V, WSL2, VBS), which hides the CPU features from Windows.
 * A running hypervisor proves virtualization is on.
 */
export interface VirtReading { firmware: boolean | null; hypervisor: boolean | null }
async function windowsVirtualization(): Promise<VirtReading> {
  if (platform() !== "win32") return { firmware: null, hypervisor: null };
  try {
    const script = "$c = Get-CimInstance Win32_ComputerSystem; $p = Get-CimInstance Win32_Processor | Select-Object -First 1; \"$($c.HypervisorPresent),$($p.VirtualizationFirmwareEnabled)\"";
    const p = Bun.spawn(["powershell", "-NoProfile", "-Command", script], { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const [hyp, fw] = (await new Response(p.stdout).text()).trim().toLowerCase().split(",");
    const b = (s?: string) => (s === "true" ? true : s === "false" ? false : null);
    return { hypervisor: b(hyp), firmware: b(fw) };
  } catch { return { firmware: null, hypervisor: null }; }
}

export async function pcCheck(cfg: Config): Promise<Check[]> {
  const ramGb = totalmem() / 1024 ** 3;
  let freeGb = NaN;
  try { const s = statfsSync(existsSync(cfg.downloadsDir) ? cfg.downloadsDir : homedir()); freeGb = (s.bavail * s.bsize) / 1024 ** 3; } catch { /* unknown */ }
  const r = await (cfg.virtualizationProbe ?? windowsVirtualization)();
  const virtCheck: Check = r.hypervisor === true
    ? { id: "virtualization", label: "Virtualization", verdict: "pass", value: "Turned on", advice: "Ready. Windows is already using it for its own features, so VirtualBox may run a little slower. That's fine for the course." }
    : r.firmware === true
      ? { id: "virtualization", label: "Virtualization", verdict: "pass", value: "Turned on", advice: "Ready." }
      : r.firmware === false && r.hypervisor === false
        ? { id: "virtualization", label: "Virtualization", verdict: "fail", value: "Turned off", advice: "Your PC needs one setting turned on before the lab can run. We'll show you how." }
        : { id: "virtualization", label: "Virtualization", verdict: "unknown", value: "Couldn't tell", advice: "We'll find out when VirtualBox starts." };
  return [
    virtCheck,
    {
      id: "ram", label: "Memory (RAM)",
      verdict: ramGb >= 15 ? "pass" : ramGb >= 7.5 ? "warn" : "fail",
      value: `${Math.round(ramGb)} GB`,
      advice: ramGb >= 15 ? "Plenty for the full lab." : ramGb >= 7.5 ? "Enough, but close other programs while the lab runs." : "8 GB is the minimum for Kali. The lab may not start.",
    },
    {
      id: "disk", label: "Free disk space",
      verdict: Number.isNaN(freeGb) ? "unknown" : freeGb >= 80 ? "pass" : freeGb >= 50 ? "warn" : "fail",
      value: Number.isNaN(freeGb) ? "Couldn't tell" : `${Math.round(freeGb)} GB free`,
      advice: Number.isNaN(freeGb) ? "Make sure you have about 80 GB free." : freeGb >= 80 ? "Plenty of room." : freeGb >= 50 ? "Enough, but it will be tight." : "The lab needs about 80 GB. Free up space first.",
    },
  ];
}

// ── State (ISC-5) ─────────────────────────────────────────────────────────
const statePath = (cfg: Config) => join(cfg.stateDir, "state.json");
export function loadState(cfg: Config): RunState | null {
  try { return JSON.parse(readFileSync(statePath(cfg), "utf8")) as RunState; } catch { return null; }
}
function saveState(cfg: Config, s: RunState): void {
  s.updatedAt = new Date().toISOString();
  mkdirSync(cfg.stateDir, { recursive: true });
  const tmp = statePath(cfg) + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, statePath(cfg));
}
export function newRun(profile: ProfileId, picks?: StepId[]): RunState {
  const plan = planFor(profile, picks);
  return { profile, plan, steps: Object.fromEntries(plan.map((id) => [id, { state: "waiting", progress: 0 }])), status: "idle" };
}

// ── Guided lab download (ISC-6) ───────────────────────────────────────────
export interface LabsFile { found: boolean; name?: string; sizeMb?: number; verified?: boolean; error?: { what: string; todo: string } }
export function findLabsFile(cfg: Config): LabsFile {
  let names: string[] = [];
  try { names = readdirSync(cfg.downloadsDir); } catch { return { found: false }; }
  const hits = names.filter((n) => cfg.labsFilePattern.test(n) && !n.endsWith(".crdownload") && !n.endsWith(".part"))
    .map((n) => ({ n, s: statSync(join(cfg.downloadsDir, n)) })).filter((x) => x.s.isFile()).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
  if (hits.length === 0) return { found: false };
  const { n, s } = hits[0];
  const base: LabsFile = { found: true, name: n, sizeMb: Math.round((s.size / 1024 ** 2) * 10) / 10 };
  if (s.size === 0) return { ...base, verified: false, error: { what: "The lab file is empty, so the download didn't finish.", todo: "Delete it from Downloads and download it again from the course page." } };
  if (!cfg.labsSha256) return { ...base, verified: true };
  const sha = createHash("sha256").update(readFileSync(join(cfg.downloadsDir, n))).digest("hex");
  return sha === cfg.labsSha256.toLowerCase() ? { ...base, verified: true } : { ...base, verified: false, error: { what: `"${n}" isn't the lab file this installer expects.`, todo: "Download the web-app labs file again from the course page, then press Check again." } };
}

// ── Help bundle (ISC-8) ───────────────────────────────────────────────────
export function helpBundle(state: RunState | null, checks: Check[] | null): string {
  const user = (() => { try { return userInfo().username; } catch { return ""; } })();
  const home = homedir();
  const lines = [
    "PEH Lab Setup: help bundle",
    `Created: ${new Date().toISOString()}`,
    `System: ${platform()} ${release()}`,
    `Profile: ${state?.profile ?? "none"} | Status: ${state?.status ?? "not started"}`,
    ...(state ? state.plan.map((id) => `  ${STEP_INFO[id].title}: ${state.steps[id]?.state ?? "?"}`) : []),
    ...(state?.failure ? [`Error ${state.failure.code} at ${state.failure.step}: ${state.failure.what}`] : []),
    ...(state?.failure?.detail ? [`Detail: ${state.failure.detail.replace(/\s+/g, " ").trim().slice(0, 600)}`] : []), // ISC-45
    ...(checks ? checks.map((c) => `  Check ${c.label}: ${c.verdict} (${c.value})`) : []),
  ];
  let text = lines.join("\n");
  const scrub = (s: string, word: string, to: string) => (word ? s.split(word).join(to) : s);
  text = scrub(text, home, "~");
  text = scrub(text, home.replaceAll("\\", "/"), "~");
  if (user.length >= 2) text = text.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<user>");
  const host = hostname();
  if (host.length >= 2) text = text.replace(new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<pc>");
  return text;
}

/** The real step for `id` when it is enabled on this machine, else null (simulated). */
function realStep(cfg: Config, id: StepId): Step | null {
  if (!cfg.realSteps.has(id)) return null;
  const sys = realSys(join(cfg.stateDir, "downloads"));
  if (id === "virtualbox") return virtualboxStep(sys, VIRTUALBOX);
  if (id === "kali-download") return kaliDownloadStep(sys, KALI, SEVENZR);
  if (id === "kali-import") return kaliImportStep(sys, KALI);
  if (id === "pimpmykali") return pimpmykaliStep(sys, PIMPMYKALI);
  return null;
}

// ── Runner ────────────────────────────────────────────────────────────────
export class Runner {
  state: RunState | null;
  private abort: AbortController | null = null;
  constructor(private cfg: Config, private makeStep: (id: StepId) => Step = (id) => realStep(cfg, id) ?? simulatedStep(id, cfg.msPerMinute, cfg.failAt)) {
    this.state = loadState(cfg);
  }
  start(profile: ProfileId, picks?: StepId[]): RunState {
    if (this.state?.status === "running") return this.state;
    this.state = newRun(profile, picks);
    this.state.startedAt = new Date().toISOString();
    saveState(this.cfg, this.state);
    void this.loop();
    return this.state;
  }
  /** After a restart: carry on from the first unfinished step (ISC-5). */
  resume(): boolean {
    const s = this.state;
    if (!s || s.status !== "running") return false;
    for (const id of s.plan) if (s.steps[id].state === "running") s.steps[id] = { state: "waiting", progress: 0 };
    saveState(this.cfg, s);
    void this.loop();
    return true;
  }
  retry(): RunState | null {
    const s = this.state;
    if (!s || s.status !== "failed") return s;
    const redo = s.failure?.redo;
    for (const id of s.plan) if (s.steps[id].state === "failed" || id === redo) s.steps[id] = { state: "waiting", progress: 0 }; // ISC-57
    delete s.failure;
    s.status = "running";
    this.cfg.failAt = undefined;
    saveState(this.cfg, s);
    void this.loop();
    return s;
  }
  /** The student said yes to the waiting question; run that step again with `confirmed` (ISC-49). */
  confirm(): RunState | null {
    const s = this.state;
    if (!s?.question) return s;
    const id = s.question.step;
    s.confirmed = [...new Set([...(s.confirmed ?? []), id])];
    delete s.question;
    s.steps[id] = { state: "waiting", progress: 0 };
    saveState(this.cfg, s);
    void this.loop();
    return s;
  }
  /** The student finished the guided download; continue the run. */
  labsReady(): void {
    const s = this.state;
    if (!s || s.steps["labs-download"]?.state !== "needs-you") return;
    s.steps["labs-download"] = { state: "done", progress: 1 };
    saveState(this.cfg, s);
    void this.loop();
  }
  private async loop(): Promise<void> {
    const s = this.state;
    if (!s) return;
    s.status = "running";
    this.abort = new AbortController();
    for (const id of s.plan) {
      if (s.steps[id].state === "done") continue;
      if (STEP_INFO[id].needsStudent) {
        s.steps[id] = { state: "needs-you", progress: 0 };
        saveState(this.cfg, s);
        return; // waits for labsReady()
      }
      if (s.question?.step === id) delete s.question; // asked before a restart; the step asks again if it still needs to
      s.steps[id] = { state: "running", progress: 0 };
      saveState(this.cfg, s);
      try {
        let last = 0;
        await this.makeStep(id).run({ signal: this.abort.signal, confirmed: s.confirmed?.includes(id) ?? false, progress: (f) => { s.steps[id].progress = f; if (f - last >= 0.1 || f === 1) { last = f; saveState(this.cfg, s); } } });
        s.steps[id] = { state: "done", progress: 1 };
        saveState(this.cfg, s);
      } catch (e) {
        const q = (e as { question?: StepQuestion }).question;
        if (q) {
          s.steps[id] = { state: "needs-you", progress: 0 };
          s.question = { ...q, step: id };
          saveState(this.cfg, s);
          return; // waits for confirm()
        }
        const f = (e as { failure?: StepFailure }).failure ?? { code: `ERR-${id}`, what: `${STEP_INFO[id].title} didn't finish.`, todo: "Press Try again. If it fails twice, copy the help bundle and post it in the support channel." };
        s.steps[id] = { state: "failed", progress: s.steps[id].progress };
        s.status = "failed";
        s.failure = { ...f, step: id };
        saveState(this.cfg, s);
        return;
      }
    }
    s.status = "done";
    saveState(this.cfg, s);
  }
  stop(): void { this.abort?.abort(); }
}

// ── HTTP ──────────────────────────────────────────────────────────────────
export function page(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${uiHtml}</body></html>`;
}

export function createApp(cfg: Config) {
  const runner = new Runner(cfg);
  let lastChecks: Check[] | null = null;
  /** Last time the page talked to us (any request, or the 15 s heartbeat). */
  let lastSeen = Date.now();
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    lastSeen = Date.now();
    // Only this machine's browser may talk to the installer.
    if (req.method !== "GET" && req.headers.get("x-peh-lab") !== "1") return json({ error: "forbidden" }, 403);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /": return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
      case "GET /api/health": return json({ ok: true, mode: "local" });
      case "POST /api/heartbeat": return json({ ok: true });
      case "GET /api/profiles": return json({ profiles: PROFILES, steps: STEP_INFO });
      case "GET /api/check": return json({ checks: (lastChecks = await pcCheck(cfg)) });
      case "GET /api/state": return json({ state: runner.state });
      case "POST /api/start": { const b = await req.json().catch(() => ({})) as { profile?: ProfileId; picks?: StepId[] }; return json({ state: runner.start(b.profile && b.profile in PROFILES ? b.profile : "full", b.picks) }); }
      case "POST /api/confirm": return json({ state: runner.confirm() });
      case "POST /api/retry": return json({ state: runner.retry() });
      case "GET /api/labs": return json({ file: findLabsFile(cfg), pageUrl: cfg.labsPageUrl });
      case "POST /api/labs/ready": { const f = findLabsFile(cfg); if (f.found && f.verified) runner.labsReady(); return json({ file: f, state: runner.state }); }
      case "GET /api/help-bundle": return json({ text: helpBundle(runner.state, lastChecks) });
      default: return json({ error: "not found" }, 404);
    }
  }
  return { handle, runner, lastSeen: () => lastSeen };
}

if (import.meta.main) {
  const cfg = defaultConfig();
  // One copy only: if one is already running, just reopen its page (ISC-34).
  const running = await existingInstance(cfg.stateDir);
  if (running) { openBrowser(running); process.exit(0); }
  if (process.argv.includes("--demo-fail")) cfg.failAt = "kali-download";
  const app = createApp(cfg);
  app.runner.resume();
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PEH_PORT ?? 0), fetch: app.handle });
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`PEH Lab Setup is running at ${url}`);
  writeInstance(cfg.stateDir, server.port);
  if (!process.argv.includes("--no-open")) openBrowser(url);
  // Exit once nobody has the page open and nothing is installing (ISC-32, ISC-33).
  setInterval(() => {
    if (!shouldExit({ now: Date.now(), lastSeen: app.lastSeen(), state: app.runner.state })) return;
    console.log(`No page open for ${IDLE_EXIT_MS / 60_000} minutes and nothing installing; exiting.`);
    clearInstance(cfg.stateDir);
    server.stop(true);
    process.exit(0);
  }, Number(process.env.PEH_IDLE_CHECK_MS ?? 30_000));
}

function openBrowser(url: string): void {
  const cmd = platform() === "win32" ? ["cmd", "/c", "start", "", url] : platform() === "darwin" ? ["open", url] : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", windowsHide: true }); } catch { /* the URL is printed */ }
}
