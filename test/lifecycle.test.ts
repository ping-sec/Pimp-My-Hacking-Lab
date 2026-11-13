import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_EXIT_MS, existingInstance, shouldExit, writeInstance } from "../src/lifecycle";
import { newRun } from "../src/server";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const T0 = 1_000_000;

describe("lifecycle", () => {
  test("ISC-32 exits after 3 idle minutes when nothing is running", () => {
    expect(IDLE_EXIT_MS).toBe(3 * 60_000);
    expect(shouldExit({ now: T0 + IDLE_EXIT_MS - 1, lastSeen: T0, state: null })).toBe(false);
    expect(shouldExit({ now: T0 + IDLE_EXIT_MS + 1, lastSeen: T0, state: null })).toBe(true);
    const waiting = newRun("full"); waiting.status = "running"; waiting.steps["labs-download"].state = "needs-you";
    for (const id of ["virtualbox", "kali-download", "kali-import", "pimpmykali"]) waiting.steps[id].state = "done";
    expect(shouldExit({ now: T0 + IDLE_EXIT_MS + 1, lastSeen: T0, state: waiting })).toBe(true);
    const failed = newRun("full"); failed.status = "failed";
    expect(shouldExit({ now: T0 + IDLE_EXIT_MS + 1, lastSeen: T0, state: failed })).toBe(true);
  });
  test("ISC-33 a running step keeps the process alive; it exits 3 minutes after finishing", () => {
    const busy = newRun("full"); busy.status = "running"; busy.steps["kali-download"].state = "running";
    expect(shouldExit({ now: T0 + 60 * 60_000, lastSeen: T0, state: busy })).toBe(false);
    const done = newRun("kali"); done.status = "done"; done.updatedAt = new Date(T0 + 50 * 60_000).toISOString();
    expect(shouldExit({ now: T0 + 50 * 60_000 + 60_000, lastSeen: T0, state: done })).toBe(false);
    expect(shouldExit({ now: T0 + 50 * 60_000 + IDLE_EXIT_MS + 1, lastSeen: T0, state: done })).toBe(true);
  });
  test("ISC-34 a second launch finds the running copy; a stale record is ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-")); dirs.push(dir);
    expect(await existingInstance(dir)).toBeNull();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, mode: "local" }) });
    writeInstance(dir, server.port);
    expect(await existingInstance(dir)).toBe(`http://127.0.0.1:${server.port}/`);
    server.stop(true);
    expect(await existingInstance(dir)).toBeNull();
  });
  test("ISC-35 the page checks in every 15 seconds on every screen", async () => {
    const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();
    expect(html).toMatch(/setInterval\(\(\) => api\.heartbeat\(\), 15000\)/);
    expect(html).toContain('post("/api/heartbeat")');
  });
});
