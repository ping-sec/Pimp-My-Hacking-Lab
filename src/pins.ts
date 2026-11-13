/** Pinned downloads. Refresh with `bun scripts/pin-virtualbox.ts` (ISC-13). */
export interface Pin { version: string; build: string; file: string; url: string; sha256: string; pinnedAt: string }

export const VIRTUALBOX: Pin = {
  version: "7.2.22",
  build: "175245",
  file: "VirtualBox-7.2.22-175245-Win.exe",
  url: "https://download.virtualbox.org/virtualbox/7.2.22/VirtualBox-7.2.22-175245-Win.exe",
  sha256: "afd0ff1656cbe04ed88ce619594ae021419d97cce89fa9bdc443e9a963f1713f",
  pinnedAt: "2026-11-12",
};

/** Kali's pre-built VirtualBox image; SHA-256 from https://cdimage.kali.org/kali-2026.3/SHA256SUMS. */
export const KALI: Pin = {
  version: "2026.3",
  build: "",
  file: "kali-linux-2026.3-virtualbox-amd64.7z",
  url: "https://cdimage.kali.org/kali-2026.3/kali-linux-2026.3-virtualbox-amd64.7z",
  sha256: "84863c4fa46b2f1b29b152348583c6fb20f68f91971617c0d684e0eb163aab6d",
  pinnedAt: "2026-11-12",
};

/**
 * 7-Zip's standalone extractor (7-Zip 26.06). 7-zip.org publishes no checksums, so this hash was
 * recorded from the official download on the pin date (trust on first use).
 */
export const SEVENZR: Pin = {
  version: "26.06",
  build: "",
  file: "7zr.exe",
  url: "https://www.7-zip.org/a/7zr.exe",
  sha256: "256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282",
  pinnedAt: "2026-11-12",
};

/** PimpMyKali (TCM-Security/pimpmykali, the maintained repo) pinned to one commit; `build` is the commit SHA. */
export const PIMPMYKALI: Pin = {
  version: "2.0.6",
  build: "3b6e37a22a457c7a94bb82d81d3b8f2624c0addd",
  file: "pimpmykali.sh",
  url: "https://raw.githubusercontent.com/TCM-Security/pimpmykali/3b6e37a22a457c7a94bb82d81d3b8f2624c0addd/pimpmykali.sh",
  sha256: "8dcb89f10807881150ae491c49c17de849307963d4f5c5cfcc1efd247e505846",
  pinnedAt: "2026-11-13",
};
