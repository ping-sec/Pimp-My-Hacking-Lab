import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Runner, createApp, defaultConfig, findLabsFile, helpBundle, pcCheck, type Config } from "../src/server";
import { PROFILES, STEP_INFO, planFor, simulatedStep, type Step } from "../src/steps";

const dirs: string[] = [];
function cfg(over: Partial<Config> = {}): Config {
  const d = mkdtempSync(join(tmpdir(), "peh-")); dirs.push(d);
  return { ...defaultConfig(), stateDir: join(d, "state"), downloadsDir: join(d, "dl"), msPerMinute: 2, ...over };
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(10); } };

describe("server", () => {
  test("ISC-2 PC check gives virtualization, RAM and disk each a verdict", async () => {
    const checks = await pcCheck(cfg({ virtualizationProbe: async () => ({ firmware: false, hypervisor: false }) }));
    expect(checks.map((c) => c.id)).toEqual(["virtualization", "ram", "disk"]);
    for (const c of checks) expect(["pass", "warn", "fail", "unknown"]).toContain(c.verdict);
    expect(checks[0].verdict).toBe("fail");
    expect(checks[0].advice.length).toBeGreaterThan(10);
  });
  test("ISC-36 a running hypervisor means virtualization is on, with a speed note", async () => {
    const [v] = await pcCheck(cfg({ virtualizationProbe: async () => ({ firmware: false, hypervisor: true }) }));
    expect(v.verdict).toBe("pass");
    expect(v.advice).toMatch(/slower/);
  });
  test("ISC-37 fails only when both readings say off; the guide lets students continue anyway", async () => {
    expect((await pcCheck(cfg({ virtualizationProbe: async () => ({ firmware: false, hypervisor: false }) })))[0].verdict).toBe("fail");
    expect((await pcCheck(cfg({ virtualizationProbe: async () => ({ firmware: true, hypervisor: false }) })))[0].verdict).toBe("pass");
    expect((await pcCheck(cfg({ virtualizationProbe: async () => ({ firmware: null, hypervisor: null }) })))[0].verdict).toBe("unknown");
    const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();
    expect(html).toContain('id="bios-override"');
    expect(html).toContain("continue anyway");
  });
  test("ISC-4 every step has a plain title and a minute estimate", () => {
    for (const id of PROFILES.full.steps) { expect(STEP_INFO[id].title).toMatch(/^[A-Z][a-z]/); expect(STEP_INFO[id].minutes).toBeGreaterThan(0); }
  });
  test("ISC-5 state persists and a restarted runner resumes the unfinished step", async () => {
    const c = cfg();
    const r1 = new Runner(c);
    r1.start("kali");
    await until(() => r1.state!.steps["kali-download"].state === "running");
    r1.stop();
    await until(() => r1.state!.status === "failed");
    // Simulate a reboot: rewrite the saved state as "running" mid-step, then a fresh runner resumes.
    const saved = JSON.parse(await Bun.file(join(c.stateDir, "state.json")).text());
    saved.status = "running"; delete saved.failure; saved.steps["kali-download"].state = "running";
    writeFileSync(join(c.stateDir, "state.json"), JSON.stringify(saved));
    const r2 = new Runner(c);
    expect(r2.state!.steps.virtualbox.state).toBe("done");
    expect(r2.resume()).toBe(true);
    await until(() => r2.state!.status === "done");
    expect(r2.state!.plan.every((id) => r2.state!.steps[id].state === "done")).toBe(true);
  });
  test("ISC-6 finds the newest lab file and verifies its checksum", async () => {
    const good = "lab contents", sha = createHash("sha256").update(good).digest("hex");
    const c = cfg({ labsSha256: sha });
    expect(findLabsFile(c).found).toBe(false);
    const { mkdirSync } = await import("node:fs"); mkdirSync(c.downloadsDir, { recursive: true });
    writeFileSync(join(c.downloadsDir, "PEH-Web-Labs.zip"), good);
    expect(findLabsFile(c)).toMatchObject({ found: true, verified: true });
    await Bun.sleep(20);
    writeFileSync(join(c.downloadsDir, "peh-web-labs (1).zip"), "something else");
    const bad = findLabsFile(c);
    expect(bad.verified).toBe(false);
    expect(bad.error!.what).toContain("isn't the lab file");
  });
  test("ISC-8 help bundle carries no username or home path", () => {
    const user = userInfo().username;
    const text = helpBundle({ profile: "full", plan: ["virtualbox"], steps: { virtualbox: { state: "failed", progress: 0.5 } }, status: "failed", failure: { step: "virtualbox", code: "X", what: `Failed writing ${homedir()}/x for ${user}`, todo: "t" } }, null);
    expect(text).not.toContain(homedir());
    expect(text.toLowerCase()).not.toContain(user.toLowerCase());
    expect(text).toContain("PEH Lab Setup: help bundle");
  });
  test("ISC-45 the help bundle shows the tool error text, trimmed and scrubbed", () => {
    const user = userInfo().username;
    const detail = `/bin/bash: cannot execute binary file (${homedir()}\\AppData for ${user}) ` + "x".repeat(2000);
    const text = helpBundle({ profile: "full", plan: ["pimpmykali"], steps: { pimpmykali: { state: "failed", progress: 0.1 } }, status: "failed", failure: { step: "pimpmykali", code: "PMK-BOOT", what: "w", todo: "t", detail } }, null);
    expect(text).toContain("Detail: /bin/bash: cannot execute binary file");
    expect(text).not.toContain(homedir());
    expect(text.toLowerCase()).not.toContain(user.toLowerCase());
    expect(text.length).toBeLessThan(1500);
  });
  test("ISC-10 profiles and picks change the step plan", () => {
    expect(planFor("full")).toEqual(PROFILES.full.steps);
    expect(planFor("kali")).not.toContain("labs-download");
    expect(planFor("weblabs")[0]).toBe("labs-download");
    expect(planFor("full", ["pimpmykali", "virtualbox"])).toEqual(["virtualbox", "pimpmykali", "final-check"]);
  });
  test("ISC-11 steps share one typed interface; the simulated runner completes a plan", async () => {
    const step: Step = simulatedStep("snapshot", 2);
    let last = 0; await step.run({ signal: new AbortController().signal, progress: (f) => { last = f; } });
    expect(last).toBe(1);
    const c = cfg(); const r = new Runner(c, (id) => simulatedStep(id, 1));
    r.start("full");
    await until(() => r.state!.steps["labs-download"].state === "needs-you");
    r.labsReady();
    await until(() => r.state!.status === "done");
  });
  test("ISC-49 a step's question pauses the run as needs-you; confirm continues it, and the yes survives a restart", async () => {
    const c = cfg();
    const seen: boolean[] = [];
    const asking = (id: Parameters<typeof simulatedStep>[0]): Step => id !== "virtualbox" ? simulatedStep(id, 1) : {
      id, ...STEP_INFO.virtualbox,
      async run({ progress, confirmed }) {
        seen.push(confirmed === true);
        if (!confirmed) throw Object.assign(new Error("q"), { question: { code: "VBOX-UPGRADE", what: "You have VirtualBox 7.0.14.", todo: "Your virtual machines are kept.", confirm: "Upgrade VirtualBox" } });
        progress(1);
      },
    };
    const r = new Runner(c, asking);
    r.start("kali");
    await until(() => r.state!.steps.virtualbox.state === "needs-you");
    expect(r.state!.status).toBe("running");
    expect(r.state!.question?.step).toBe("virtualbox");
    expect(r.state!.question?.confirm).toBe("Upgrade VirtualBox");
    // A restart before the answer asks again.
    const again = new Runner(c, asking);
    again.resume();
    await until(() => seen.length === 2);
    expect(seen).toEqual([false, false]);
    // The yes, through the API.
    const app = createApp(c);
    (app.runner as unknown as { makeStep: typeof asking }).makeStep = asking;
    const res = await app.handle(new Request("http://127.0.0.1/api/confirm", { method: "POST", headers: { "x-peh-lab": "1" } }));
    expect(res.status).toBe(200);
    await until(() => app.runner.state!.steps.virtualbox.state === "done");
    expect(app.runner.state!.question).toBeUndefined();
    expect(app.runner.state!.confirmed).toContain("virtualbox");
    expect(seen.at(-1)).toBe(true);
  });
  test("ISC-49 a question left from before a restart is cleared once the step no longer asks", async () => {
    const c = cfg();
    const asks = (id: Parameters<typeof simulatedStep>[0]): Step => id !== "virtualbox" ? simulatedStep(id, 1) : { id, ...STEP_INFO.virtualbox, async run() { throw Object.assign(new Error("q"), { question: { code: "VBOX-UPGRADE", what: "w", todo: "t", confirm: "Upgrade VirtualBox" } }); } };
    const r = new Runner(c, asks);
    r.start("kali");
    await until(() => r.state!.question !== undefined);
    // Restart after the student upgraded VirtualBox by hand: the step now passes without asking.
    const later = new Runner(c, (id) => simulatedStep(id, 1));
    later.resume();
    await until(() => later.state!.steps.virtualbox.state === "done");
    expect(later.state!.question).toBeUndefined();
  });
  test("API refuses POSTs without the installer header", async () => {
    const app = createApp(cfg());
    const res = await app.handle(new Request("http://127.0.0.1/api/start", { method: "POST", body: "{}" }));
    expect(res.status).toBe(403);
    const ok = await app.handle(new Request("http://127.0.0.1/api/health"));
    expect((await ok.json()).mode).toBe("local");
  });
});

describe("retry", () => {
  test("ISC-57 a failure that names a step to redo makes Try again run that step first", async () => {
    // VirtualBox's step finished, then VirtualBox went missing before PimpMyKali ran (help bundle, 2026-11-13).
    const runs: string[] = [];
    const vboxRuns = () => runs.filter((x) => x === "virtualbox").length;
    const make = (id: string): Step => ({
      id, ...STEP_INFO[id as keyof typeof STEP_INFO],
      async run() {
        runs.push(id);
        if (id === "pimpmykali" && vboxRuns() < 2) throw Object.assign(new Error("x"), { failure: { code: "PMK-NOVBOX", what: "x", todo: "y", redo: "virtualbox" } });
      },
    } as Step);
    const r = new Runner(cfg(), make as never);
    r.start("full", ["virtualbox", "kali-download", "kali-import", "pimpmykali"]);
    await until(() => r.state!.status !== "running");
    expect(r.state!.failure?.code).toBe("PMK-NOVBOX");
    r.retry();
    await until(() => r.state!.status !== "running");
    expect(vboxRuns()).toBe(2);
    expect(r.state!.steps.pimpmykali.state).toBe("done");
    expect(runs.filter((x) => x === "kali-import").length).toBe(1); // other finished steps are not redone
  });
});
