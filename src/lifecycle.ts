/**
 * Keeps exactly one copy running, and only while it is useful (F7).
 * The exe has no window, so without this it would sit in the background forever and lock
 * its own file (seen 2026-11-12 on the share).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./server";

export const IDLE_EXIT_MS = 3 * 60_000;
const INSTANCE = "instance.json";

/** True when nobody has the page open and nothing is installing (ISC-32, ISC-33). */
export function shouldExit(o: { now: number; lastSeen: number; state: RunState | null }): boolean {
  if (o.now - o.lastSeen < IDLE_EXIT_MS) return false;
  const s = o.state;
  if (s?.status === "running" && s.plan.some((id) => s.steps[id]?.state === "running")) return false;
  if (s?.status === "done" && s.updatedAt && o.now - Date.parse(s.updatedAt) < IDLE_EXIT_MS) return false;
  return true;
}

export function writeInstance(dir: string, port: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INSTANCE), JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));
}
export function clearInstance(dir: string): void { rmSync(join(dir, INSTANCE), { force: true }); }

/** The page URL of a copy that is already running and answering, else null (ISC-34). */
export async function existingInstance(dir: string): Promise<string | null> {
  let port: number;
  try { port = Number(JSON.parse(readFileSync(join(dir, INSTANCE), "utf8")).port); } catch { return null; }
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const d = (await r.json()) as { mode?: string };
    return r.ok && d.mode === "local" ? `http://127.0.0.1:${port}/` : null;
  } catch { return null; }
}
