# Huginn

A calm, read-only map of your own home or lab network. Huginn runs entirely on your
own machine, shows the devices on your network and the traffic leaving your PC, and
explains in plain words what each thing is doing and why. It never changes, blocks,
or deletes anything, and it makes no outbound internet connections of its own.

## Get it running (Windows)

1. Download the ready-to-run bundle from the [Releases](../../releases) page
   (`HuginnKit.zip` includes Node and Python, so there is nothing else to install).
2. Unzip it anywhere.
3. Double-click **Start.bat**. It asks your permission, detects the network you are on,
   and opens the map in your browser at `http://127.0.0.1:33613`.

That is it. To stop it, close the window.

## What it does, and does not, do

- Binds to `127.0.0.1` only. It does not open a port to your network or the internet.
- Reads: the devices answering on your network, your own PC's traffic, and (optionally)
  a Pi-hole's query log if you have one.
- Does not: log in to anything, guess passwords, run exploits, change settings, or send
  your data anywhere.

## Try the Practice drill

Under **More > Practice drill** you can run a safe, simulated attack and watch Huginn
light up, then read the step-by-step on how you would respond. Scenarios include a full
outside-in attack (recon, break-in, foothold, phone-home, spread, steal), a rogue device
and port scan, a command-and-control beacon, and data exfiltration. It is entirely
synthetic: nothing touches your real network.

## Live packet view (optional)

The map and everything above work with no driver. The live packet "sparks" (your PC's own
packets moving on the map) need a capture driver, Npcap. We cannot ship Npcap (its free
licence does not allow redistributing the installer), so you add it once: download it from
[npcap.com](https://npcap.com), drop the installer in the `capture/` folder, and run
**Enable-Capture.bat** as administrator. It verifies the installer, shows its SHA-256, and
runs the official signed installer. Npcap is a kernel driver, so on a managed PC this is the
step most likely to need IT approval.

## Permission, first

Only run Huginn on a network you own or have **written permission** to watch. Scanning a
network you do not run, even gently, can break its rules. The `for-IT/` folder has a plain
security review you can hand to whoever runs the network.

## What is inside

- **huginn/** the dashboard (Node)
- **odin/** the network lister (Python)
- **muninn/** an optional, read-only Windows host audit (PowerShell, run as admin)
- **for-IT/** a security review and a defender's playbook
- **Enable-Capture.bat / capture/** optional live-capture setup (installs Npcap)
- **runtime/** bundled Node and Python (in the release zip, not in this repo)

Read-only recon on networks you are allowed to watch. Nothing here attacks, exploits, or
phones home.
