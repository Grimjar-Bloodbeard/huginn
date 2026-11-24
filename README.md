# Huginn

A calm, read-only map of your own home or lab network. Huginn runs entirely on your
own machine, shows the devices on your network and the traffic leaving your PC, and
explains in plain words what each thing is doing and why. It never changes, blocks,
or deletes anything, and it makes no outbound internet connections of its own.

## Linux (preview): one line

```
curl -fsSL https://raw.githubusercontent.com/Grimjar-Bloodbeard/huginn/linux-preview/install.sh | bash
```

Then type `huginn`. It opens the map at `http://127.0.0.1:33613`.

- It asks before installing anything it needs (Node.js 18+, Python 3), and only uses `sudo` for that.
- `huginn capture` turns on the live packet view: one `sudo` step that lets Huginn's own private
  Python read this machine's packets. No driver to install on Linux.
- `huginn uninstall` removes it (and asks before deleting saved data).
- **Termux (Android)** works with the same line (install Termux from F-Droid, not the Play Store).
  On a phone the map lists devices by address only and there are no live packets (Android needs
  root for those), but Enumerate, the explainer and the Practice drill all work.

This is a preview: tell us what breaks.

## Windows

1. Download the ready-to-run bundle from the [Releases](../../releases) page
   (`HuginnKit.zip` includes Node and Python, so there is nothing else to install).
2. Unzip it anywhere.
3. Double-click **Start.bat**. It asks your permission, detects the network you are on,
   and opens the map in your browser at `http://127.0.0.1:33613`.

For the live packet view on Windows, put the official Npcap installer (from
[npcap.com](https://npcap.com); its licence doesn't allow us to bundle it) in `capture/` and run
**Enable-Capture.bat** as administrator. It verifies the installer and shows its SHA-256 first.

## What it does, and does not, do

- Binds to `127.0.0.1` only. It does not open a port to your network or the internet.
- Reads: the devices answering on your network, your own machine's traffic, and (optionally)
  a Pi-hole's query log if you have one.
- Does not: log in to anything, guess passwords, run exploits, change settings, or send
  your data anywhere.

## Try the Practice drill

Under **More > Practice drill** you can run a safe, simulated attack and watch Huginn light up,
then read the step-by-step on how you would respond: a full outside-in attack (recon, break-in,
foothold, phone-home, spread, steal), a rogue device and port scan, a command-and-control beacon,
and data exfiltration. It is entirely synthetic: nothing touches your real network.

## Permission, first

Only run Huginn on a network you own or have **written permission** to watch. Scanning a
network you do not run, even gently, can break its rules. The `for-IT/` folder has a plain
security review you can hand to whoever runs the network.

## What is inside

- **huginn/** the dashboard (Node)
- **odin/** the network lister (Python)
- **muninn/** an optional, read-only Windows host audit (PowerShell, run as admin)
- **for-IT/** a security review and a defender's playbook
- **install.sh** the Linux / Termux installer
- **Start.bat, Enable-Capture.bat, capture/** the Windows launcher and live-capture setup
- **runtime/** bundled Node and Python for Windows (in the release zip, not in this repo)

Read-only recon on networks you are allowed to watch. Nothing here attacks, exploits, or
phones home.
