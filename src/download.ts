/**
 * One downloader for every big file (F9). A stalled or dropped connection is retried by itself and
 * resumes from where it stopped (HTTP Range into `<dest>.part`), so a flaky network never costs the
 * student a restart or the bytes already downloaded. The step fails only after 8 attempts in a row
 * that brought no new bytes, and the partial file stays so "Try again" resumes it.
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import type { StepFailure } from "./steps";

export const MAX_IDLE_ATTEMPTS = 8;
export const STALL_MS = 60_000;

export interface DownloadSys { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> }
export interface DownloadOpts {
  signal: AbortSignal;
  /** Fraction 0..1 of the file on disk. */
  progress: (f: number) => void;
  /** Failure code and plain name for the error message, e.g. "KALI-DL", "Kali Linux". */
  code: string;
  label: string;
  stallMs?: number;
}

const fail = (code: string, what: string, todo: string): never => { throw Object.assign(new Error(what), { failure: { code, what, todo } satisfies StepFailure }); };

/** SHA-256 of a file, read as a stream (a 3.9 GB image never sits in memory). */
export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

const sizeOf = (p: string) => (existsSync(p) ? statSync(p).size : 0);

/** One attempt. Returns true when the whole file is in `part`. */
async function attempt(sys: DownloadSys, url: string, part: string, o: DownloadOpts): Promise<boolean> {
  let have = sizeOf(part);
  const ctl = new AbortController();
  const onOuter = () => ctl.abort();
  o.signal.addEventListener("abort", onOuter, { once: true });
  let fd: number | null = null;
  try {
    const res = await sys.fetch(url, { signal: ctl.signal, headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
    if (res.status === 416) { rmSync(part, { force: true }); return false; } // our partial is bad; start over
    if (!res.ok || !res.body) return false;
    if (res.status !== 206 && have > 0) have = 0; // server ignored Range: start from zero
    const total = res.status === 206
      ? Number(res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] ?? 0)
      : Number(res.headers.get("content-length") ?? 0);
    fd = openSync(part, have > 0 ? "a" : "w");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const stallMs = o.stallMs ?? STALL_MS;
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<"stall">((r) => { timer = setTimeout(() => r("stall"), stallMs); });
      const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (next === "stall") { ctl.abort(); reader.cancel().catch(() => {}); return false; }
      if (next.done) break;
      writeSync(fd, next.value); have += next.value.length;
      if (total > 0) o.progress(Math.min(1, have / total));
    }
    return total === 0 || have >= total;
  } catch {
    return false; // dropped connection, DNS hiccup, reset: retried by the caller
  } finally {
    if (fd !== null) closeSync(fd);
    o.signal.removeEventListener("abort", onOuter);
  }
}

/** Download `url` to `dest`, resuming across stalls and drops (ISC-38..40). */
export async function downloadResumable(sys: DownloadSys, url: string, dest: string, o: DownloadOpts): Promise<void> {
  const part = `${dest}.part`, sleep = sys.sleep ?? ((ms: number) => Bun.sleep(ms));
  let idle = 0;
  for (;;) {
    if (o.signal.aborted) throw new Error("stopped");
    const before = sizeOf(part);
    if (await attempt(sys, url, part, o)) { rmSync(dest, { force: true }); renameSync(part, dest); o.progress(1); return; }
    if (o.signal.aborted) throw new Error("stopped");
    idle = sizeOf(part) > before ? 0 : idle + 1;
    if (idle >= MAX_IDLE_ATTEMPTS) fail(o.code, `${o.label} stopped downloading and didn't come back after several tries.`, "Check that you're online, then press Try again. It picks up where it left off.");
    await sleep(Math.min(30_000, 2000 * 2 ** Math.max(0, idle - 1)));
  }
}
