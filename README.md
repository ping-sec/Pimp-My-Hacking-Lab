# Pimp My Hacking Lab

One double-click on Windows sets up a beginner ethical hacking lab: VirtualBox, a Kali Linux VM, and [PimpMyKali](https://github.com/Dewalt-arch/pimpmykali) to patch it, with the Practical Ethical Hacking web-app labs on the way.

> The name is a nod to **Dewalt**, who wrote PimpMyKali and has been fixing broken Kali installs for students for years. This tool runs his script; it doesn't replace it. Go star [his repo](https://github.com/Dewalt-arch/pimpmykali).

⚠️ **Testing release.** This is an early build for testers. Run it on a PC (or a Windows VM) you don't mind experimenting on, and please report what happens.

## What it does

1. Checks your PC: virtualization, memory, disk space. If virtualization is off in your BIOS, it tells you how to turn it on for your PC's brand.
2. Installs VirtualBox 7.2.22 (one Windows permission prompt).
3. Downloads the official Kali 2026.3 VirtualBox image, then extracts and imports it as **Kali (PEH)**.
4. Boots Kali in the background and runs `pimpmykali.sh --autonoroot` inside it.

Kali gets two network adapters: NAT for internet and a private host-only lab network. It is never bridged to your home network.

Every download is pinned to an exact version and checked against its SHA-256 hash, and downloads resume if your connection drops. If you close the tool or reboot, running it again picks up where it stopped.

## How to test

1. Download `peh-lab-setup.exe` from the [latest release](../../releases).
2. Double-click it. A page opens in your browser.
3. Click **Set up my lab** and follow along. Expect about 4 GB of downloads.
4. Whether it works or breaks, [open an issue](../../issues/new/choose). If something fails, click **Copy help bundle** and paste it in. The bundle leaves out your username and home folder.

Windows SmartScreen may warn about an unrecognized app because the exe isn't code-signed yet. Click **More info → Run anyway** only if you downloaded it from this repo's releases.

## Build from source

You need [Bun](https://bun.sh).

```sh
bun test                 # 52 tests
bun run dev --simulate   # the UI with fake steps, on any OS
bun run build:win        # dist/peh-lab-setup.exe
```

## Credits

- [PimpMyKali](https://github.com/Dewalt-arch/pimpmykali) by Dewalt
- [Kali Linux](https://www.kali.org) by OffSec
- [VirtualBox](https://www.virtualbox.org) by Oracle
- [7-Zip](https://www.7-zip.org) by Igor Pavlov

Built by [Casey / Ping-Sec](https://ping-sec.com). This is an unofficial community tool.

## License

MIT. See [LICENSE](LICENSE).
