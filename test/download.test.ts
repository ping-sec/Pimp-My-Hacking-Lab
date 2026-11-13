import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadResumable, sha256File } from "../src/download";
import { launchScript } from "../src/pimpmykali";
import { PIMPMYKALI } from "../src/pins";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "dl-")); dirs.push(d); return d; };
const BODY = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
const noSleep = async () => {};

/** A server whose per-request behaviour is scripted; records the Range header of each request. */
function server(plan: Array<"stall" | "drop" | "ok" | "ignore-range" | "500">) {
  const ranges: (string | null)[] = [];
  let n = 0;
  const s = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const range = req.headers.get("range"); ranges.push(range);
      const mode = plan[Math.min(n++, plan.length - 1)];
      if (mode === "500") return new Response("busy", { status: 500 });
      const start = mode !== "ignore-range" && range ? Number(range.match(/bytes=(\d+)-/)![1]) : 0;
      const part = BODY.subarray(start);
      const headers: Record<string, string> = { "content-length": String(part.length) };
      if (start > 0) headers["content-range"] = `bytes ${start}-${BODY.length - 1}/${BODY.length}`;
      if (mode === "ok" || mode === "ignore-range") return new Response(part, { status: start > 0 ? 206 : 200, headers });
      // stall / drop: send a third of what's asked, then hang or cut the connection
      const cut = Math.floor(part.length / 3);
      const stream = new ReadableStream({
        async pull(c) {
          c.enqueue(part.subarray(0, cut));
          await Bun.sleep(50); // let the bytes reach the client before the cut
          if (mode === "drop") { c.error(new Error("connection reset")); return; }
          await new Promise(() => {}); // stall forever
        },
      });
      return new Response(stream, { status: start > 0 ? 206 : 200, headers });
    },
  });
  return { url: `http://127.0.0.1:${s.port}/kali.7z`, ranges, stop: () => s.stop(true) };
}

describe("resumable downloads (F9)", () => {
  test("ISC-38 stalls and drops are retried and resume with a Range request", async () => {
    const srv = server(["stall", "drop", "ok"]);
    const dest = join(tmp(), "kali.7z");
    const seen: number[] = [];
    await downloadResumable({ fetch, sleep: noSleep }, srv.url, dest, { signal: new AbortController().signal, progress: (f) => seen.push(f), stallMs: 300, label: "Kali Linux", code: "KALI-DL" });
    srv.stop();
    expect(Buffer.compare(readFileSync(dest), Buffer.from(BODY))).toBe(0);
    expect(srv.ranges[0]).toBeNull();
    expect(srv.ranges[1]).toMatch(/^bytes=\d+-$/);
    expect(Number(srv.ranges[2]!.match(/\d+/)![0])).toBeGreaterThan(Number(srv.ranges[1]!.match(/\d+/)![0]));
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(1);
  });

  test("ISC-39 a server that ignores Range restarts from zero and ends with the exact file", async () => {
    const srv = server(["drop", "ignore-range"]);
    const dest = join(tmp(), "kali.7z");
    await downloadResumable({ fetch, sleep: noSleep }, srv.url, dest, { signal: new AbortController().signal, progress: () => {}, stallMs: 300, label: "Kali Linux", code: "KALI-DL" });
    srv.stop();
    expect(srv.ranges[1]).toMatch(/^bytes=/);
    expect(statSync(dest).size).toBe(BODY.length);
    expect(Buffer.compare(readFileSync(dest), Buffer.from(BODY))).toBe(0);
  });

  test("ISC-40 eight attempts in a row with no new bytes fail in plain words and keep the partial file", async () => {
    const srv = server(["drop", "500"]);
    const dest = join(tmp(), "kali.7z");
    let err: any;
    try { await downloadResumable({ fetch, sleep: noSleep }, srv.url, dest, { signal: new AbortController().signal, progress: () => {}, stallMs: 300, label: "Kali Linux", code: "KALI-DL" }); } catch (e) { err = e; }
    srv.stop();
    expect(err?.failure?.code).toBe("KALI-DL");
    expect(err.failure.what).toMatch(/Kali Linux/);
    expect(srv.ranges.length).toBe(1 + 8); // the attempt that made progress, then 8 with none
    expect(statSync(`${dest}.part`).size).toBeGreaterThan(0);
  });

  test("ISC-41 the SHA-256 check streams the file", async () => {
    const p = join(tmp(), "f.bin");
    writeFileSync(p, BODY);
    expect(await sha256File(p)).toBe(createHash("sha256").update(BODY).digest("hex"));
    for (const f of ["download.ts", "kali.ts", "virtualbox.ts"]) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/update\(readFileSync/);
    }
  });

  test("ISC-42 the in-Kali PimpMyKali download retries and drops stalled connections", () => {
    const s = launchScript(PIMPMYKALI);
    expect(s).toMatch(/curl [^\n]*--retry \d+/);
    expect(s).toMatch(/--speed-time \d+/);
    expect(s).toMatch(/--speed-limit \d+/);
  });
});
