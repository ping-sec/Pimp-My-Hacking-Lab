# Pimp My Hacking Lab

One double-click on Windows or Ubuntu 24.04 sets up a beginner ethical hacking lab: VirtualBox, a Kali Linux VM, and [PimpMyKali](https://github.com/TCM-Security/pimpmykali) to patch it, with the Practical Ethical Hacking web-app labs on the way.

> The name is a nod to **Dewalt**, who wrote PimpMyKali and has been fixing broken Kali installs for students for years. This tool runs his script; it doesn't replace it. Go star [the repo](https://github.com/TCM-Security/pimpmykali).

⚠️ **Testing release.** This is an early build for testers. Run it on a PC you don't mind experimenting on, and please report what happens.

## What it does

1. Checks your PC: virtualization, memory, disk space. If virtualization is off in your BIOS, it tells you how to turn it on for your PC's brand.
2. Installs VirtualBox 7.2.22 (one permission prompt on Windows, one password prompt on Ubuntu).
3. Downloads the official Kali 2026.3 VirtualBox image, then extracts and imports it as **Kali (PEH)**.
4. Boots Kali in the background and runs `pimpmykali.sh --autonoroot` inside it.

Kali gets two network adapters: NAT for internet and a private host-only lab network. It is never bridged to your home network.

Every download is pinned to an exact version and checked against its SHA-256 hash, and downloads resume if your connection drops. If you close the tool or reboot, running it again picks up where it stopped.

## How to test on Windows

1. Download `peh-lab-setup.exe` from the [latest release](../../releases).
2. Double-click it. A page opens in your browser.
3. Click **Set up my lab** and follow along. Expect about 4 GB of downloads.
4. Whether it works or breaks, [open an issue](../../issues/new/choose). If something fails, click **Copy help bundle** and paste it in. The bundle leaves out your username and home folder.

Windows SmartScreen may warn about an unrecognized app because the exe isn't code-signed yet. Click **More info → Run anyway** only if you downloaded it from this repo's releases.

## How to test on Ubuntu 24.04

The Ubuntu version is new in v0.2.0 and hasn't been through a full run on a real Ubuntu desktop yet, so reports are extra welcome.

1. Download `pimp-my-hacking-lab_0.2.0_amd64.deb` from the [latest release](../../releases).
2. Install it: `sudo apt install ./pimp-my-hacking-lab_0.2.0_amd64.deb`
3. Open **Pimp My Hacking Lab** from your apps, click **Set up my lab**, and type your password when Ubuntu asks.
4. Report what happens, the same way as on Windows.

If Secure Boot is on, VirtualBox's driver has to be approved once. The tool shows a one-time password, restarts your PC, and walks you through the blue MokManager screen (Enroll MOK, Continue, Yes, type the password, Reboot). After you log back in it picks up where it stopped. On kernels 6.12 to 6.15 it also stops KVM from holding virtualization at boot, which needs one restart.

Other Linux distros may work, but only Ubuntu 24.04 is tested for now.

## Build from source

You need [Bun](https://bun.sh).

```sh
bun test                 # 104 tests
bun run dev --simulate   # the UI with fake steps, on any OS
bun run build:win        # dist/peh-lab-setup.exe
bun run build:deb        # dist/pimp-my-hacking-lab_<version>_amd64.deb (Ubuntu)
```

## Credits

- [PimpMyKali](https://github.com/TCM-Security/pimpmykali) by Dewalt and TCM Security
- [Kali Linux](https://www.kali.org) by OffSec
- [VirtualBox](https://www.virtualbox.org) by Oracle
- [7-Zip](https://www.7-zip.org) by Igor Pavlov

Built by [Casey / Ping-Sec](https://ping-sec.com). This is an unofficial community tool.

## License

MIT. See [LICENSE](LICENSE).
