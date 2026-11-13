/**
 * The install plan: every step behind one typed interface (ISC-11). This build ships a
 * simulated runner; real VirtualBox / Kali / PimpMyKali / Docker-in-Kali steps implement
 * the same `Step` shape later.
 */

export type StepId =
  | "virtualbox"
  | "kali-download"
  | "kali-import"
  | "pimpmykali"
  | "labs-download"
  | "labs-start"
  | "snapshot"
  | "final-check";

export type ProfileId = "full" | "kali" | "weblabs";

export interface StepContext {
  /** Called as the step makes progress, 0..1. */
  progress(fraction: number): void;
  /** Aborts a long step when the run is stopped. */
  signal: AbortSignal;
}

export interface StepFailure {
  /** One sentence: what happened. */
  what: string;
  /** One sentence: what the student should do. */
  todo: string;
  code: string;
  /** The tool's own error text, for the help bundle (ISC-45). */
  detail?: string;
}

export interface Step {
  id: StepId;
  /** Plain English, as the student sees it. */
  title: string;
  detail: string;
  minutes: number;
  /** Needs the student to do something (e.g. log in and download). */
  needsStudent?: boolean;
  run(ctx: StepContext): Promise<void>;
}

export const STEP_INFO: Record<StepId, Omit<Step, "run" | "id">> = {
  virtualbox: { title: "Install VirtualBox", detail: "The free program that runs your lab computers. Windows will ask for permission: click Yes.", minutes: 5 },
  "kali-download": { title: "Download Kali Linux", detail: "Your hacking computer, about 3.5 GB.", minutes: 15 },
  "kali-import": { title: "Set up your Kali computer", detail: "Creates the Kali virtual machine and its private lab network.", minutes: 5 },
  pimpmykali: { title: "Apply Kali fixes", detail: "Runs PimpMyKali to install the tools the course uses.", minutes: 15 },
  "labs-download": { title: "Get the web-app labs", detail: "You log in to the course and download one file. We do the rest.", minutes: 5, needsStudent: true },
  "labs-start": { title: "Start the web-app labs", detail: "Starts the practice websites inside Kali.", minutes: 5 },
  snapshot: { title: "Save a clean copy", detail: "So one click can reset your lab if anything breaks.", minutes: 1 },
  "final-check": { title: "Final check", detail: "Makes sure everything works before you start.", minutes: 1 },
};

export const PROFILES: Record<ProfileId, { title: string; detail: string; steps: StepId[] }> = {
  full: {
    title: "Everything (recommended)",
    detail: "Kali with all the course fixes, plus the web-app labs.",
    steps: ["virtualbox", "kali-download", "kali-import", "pimpmykali", "labs-download", "labs-start", "snapshot", "final-check"],
  },
  kali: {
    title: "Kali only",
    detail: "Kali with all the course fixes, no web-app labs.",
    steps: ["virtualbox", "kali-download", "kali-import", "pimpmykali", "snapshot", "final-check"],
  },
  weblabs: {
    title: "Add web-app labs",
    detail: "For students who already set up Kali with this tool.",
    steps: ["labs-download", "labs-start", "snapshot", "final-check"],
  },
};

const ORDER: StepId[] = PROFILES.full.steps;

/** The step list for a profile, or for a custom pick list (kept in install order). ISC-10 */
export function planFor(profile: ProfileId, picks?: StepId[]): StepId[] {
  if (picks && picks.length > 0) {
    const set = new Set(picks.filter((p) => p in STEP_INFO));
    set.add("final-check");
    return ORDER.filter((id) => set.has(id));
  }
  return [...PROFILES[profile].steps];
}

/** Simulated steps: same interface as the real ones, timed for a demo. */
export function simulatedStep(id: StepId, msPerMinute = 200, failAt?: StepId): Step {
  const info = STEP_INFO[id];
  return {
    id,
    ...info,
    async run(ctx) {
      const total = Math.max(1, info.minutes * msPerMinute), tick = 50;
      for (let t = 0; t <= total; t += tick) {
        if (ctx.signal.aborted) throw new Error("stopped");
        ctx.progress(Math.min(1, t / total));
        if (failAt === id && t >= total / 2) {
          const failure: StepFailure = { code: `SIM-${id}`, what: `${info.title} stopped halfway because the download was interrupted.`, todo: "Check that you're online, then press Try again. Your progress is kept." };
          throw Object.assign(new Error(failure.what), { failure });
        }
        await Bun.sleep(tick);
      }
      ctx.progress(1);
    },
  };
}
