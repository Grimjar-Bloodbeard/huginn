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

## Permission, first

Only run Huginn on a network you own or have **written permission** to watch. Scanning a
network you do not run, even gently, can break its rules. The `for-IT/` folder has a plain
security review you can hand to whoever runs the network.

## What is inside

- **huginn/** the dashboard (Node)
- **odin/** the network lister (Python)
- **muninn/** an optional, read-only Windows host audit (PowerShell, run as admin)
- **for-IT/** a security review and a defender's playbook
- **runtime/** bundled Node and Python (in the release zip, not in this repo)

Read-only recon on networks you are allowed to watch. Nothing here attacks, exploits, or
phones home.
