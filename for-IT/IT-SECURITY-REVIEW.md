# Ravens Kit — Security Review for IT

**For:** the team that runs the network and the endpoint protection (CrowdStrike/EDR).
**About:** a student-built network-visibility kit (Odin's Watch, Huginn, Muninn) that a student wants
to run, with permission, on a lab network for a class project.
**In one line:** it looks and listens; it does not attack, exploit, spread, or phone home, and the one
thing it can change (an ad-blocker's groups) only exists if you have a Pi-hole and is off in the lab.

This document is written to be checked, not just read. Everything below is visible in the source code
(it is all plain Python and JavaScript, no compiled binaries of ours), and you can confirm every claim
with your own tools. Section 9 says how.

---

## 1. What the three tools are

| Tool | Language | Job | Needs admin? |
| --- | --- | --- | --- |
| **Odin's Watch** | Python (Flask) | Lists the devices on the network | No |
| **Huginn** | Node.js | A dashboard: shows the devices, this PC's own traffic, and a map | No (Yes only for the optional packet view) |
| **Muninn** | PowerShell | A read-only audit of one computer's processes and startup items | Yes, to see everything |

They run from a USB folder. Nothing is installed into Windows (the one exception, Npcap, is optional,
described in section 5 and only with your approval). Removing the kit is deleting the folder.

---

## 2. What it does on the network (what your firewall and NDR will see)

**Odin's Watch — the only tool that actively touches other machines:**
- An **ICMP ping sweep** of one configured subnet (e.g. one /24), to find which addresses are alive.
- A **TCP connect** to a short, fixed list of common ports on the hosts that answered, to label them:
  `22, 80, 443, 8080, 8443, 445, 3389, 5000, 32400, 9100`. This is a normal `connect()` — it completes
  the handshake and closes. The **automatic sweep** does **no** SYN/stealth scanning, no raw packet
  crafting, no exploits, no payloads, no password attempts, and no version probing beyond "is the port
  open". (A separate, opt-in "Deep look" can run nmap against one device you choose — section 5a.)
- Listens for **mDNS/Bonjour** (`.local`) names on the LAN, like any phone or printer does.
- The port list and the subnet are in `odin/config.json`. You can shorten the list, or set it to `[]`
  to turn port-checking off entirely and keep only the ping sweep.

**Huginn:**
- Pings the **router** (local) for a latency number. In lab mode it makes **no** internet ping unless you
  set one (`pingTarget` in the config).
- **Reverse-DNS (PTR) lookups** for internet addresses this PC is already talking to, through the
  network's normal DNS, only to turn an address into a readable name.
- Connects to **Pi-hole** only if one is configured. In the lab there is none, so it does not.
- Optionally reads **this PC's own packets** (section 5).
- Has an opt-in **Enumerate** and an opt-in **Deep look** that actively probe *one* device the operator
  chooses (sections 5a and 5b). These are the only active, per-target features; nothing runs them
  automatically.

**Muninn:** makes **no** network connections. It reads the local machine and writes files.

**What none of them ever do:** connect out to the internet to send anything; open a listening port to
the network (both dashboards bind to `127.0.0.1` — this machine only, see section 4); scan beyond the one
configured subnet; touch another machine's files, shares, or accounts; try any credential, default
password, or exploit; move laterally; install, schedule, or persist anything.

---

## 3. What it does on the host (files and processes)

- **Odin's Watch / Huginn** run as ordinary user processes (`python.exe`, `node.exe`) from the USB folder.
  They write only inside that folder: the device list, the dashboard's settings and its rolling history
  of *who-talked-to-whom* (never packet contents). Nothing is written to Windows, the registry, or other
  users' profiles.
- **Muninn** runs as administrator (so it can read every process and service) and is **read-only by
  design**. It collects: running processes and their signatures, listening TCP connections, Run-key and
  Startup entries, scheduled tasks, and services. It writes CSV/JSON/text into its own `reports\` folder
  and **flags** items that look unusual (unsigned, or running from a user folder) for a human to judge.
  It never kills a process, deletes a file, changes a setting, or quarantines anything. The project's
  own rule, in writing in its brief: *collect and flag, never auto-remediate.*

---

## 4. The dashboards are private to the machine they run on

Both Huginn (`127.0.0.1:33613`) and Odin's Watch (`127.0.0.1:7331`) bind to **loopback only**. They are
not reachable from any other computer on the network. Huginn additionally refuses any request not
addressed to `127.0.0.1`, `localhost`, or a Tailscale name, which closes the DNS-rebinding class of attack
(a web page trying to reach a loopback service through the browser). At home the student reaches it from a
phone over Tailscale (a private, authenticated mesh); **in the lab there is no Tailscale and no remote
access — it is the console PC only.**

The dashboard page itself makes **zero outbound internet connections**: fonts and all code are served by
Huginn from the USB stick, and a Content-Security-Policy in the page enforces that the browser may load
nothing from anywhere else.

---

## 5. The one thing that needs a driver: the live packet view (optional)

Huginn can show *this PC's own* network traffic as a live animation. That reading is done with **Npcap**
(the standard, signed Windows packet-capture driver, the same one Wireshark uses). This is the only part
that needs anything installed, and it needs an administrator, so **it does not happen unless you install
Npcap and allow it.** Without Npcap, everything else in the kit works; only the live-traffic animation is
blank.

Honest detail for your review:
- Capture is **not** promiscuous. The card is left in normal mode, so Huginn sees only the frames this
  host sends and receives, plus the broadcast/multicast every host already gets. It does not and cannot
  read other machines' unicast traffic on a switched network.
- Packet **contents are never stored.** Huginn keeps only metadata: source, destination, size, time, and
  the server name from DNS/TLS SNI (which is already visible on the wire). Its 7-day history is this
  metadata only.
- The capture helper is a separate process: the kit's own `python.exe` (from `runtime\python`)
  running `huginn\command\sniffer.py` (scapy), started by Huginn. It is the process that opens the
  Npcap handle, not `node.exe`.
- **On the lab stick the capture helper is not even started** unless both of these are true:
  Npcap is installed on this PC, *and* capture has been switched on for this kit
  (`"capture": true` in `site\huginn.config.json`). `Enable-Capture.bat` sets that switch only
  when someone runs it after you approve and install Npcap. Setting `"capture": false` keeps it off
  for good, whatever is installed.
- If you would rather it never capture, do not install Npcap (or uninstall it afterward), or set
  `"capture": false`.

> **Correction, 2026-11-24.** Earlier versions of the kit started the capture helper on every run,
> even when Npcap was not installed. With no driver it could not capture anything, so it failed and
> relaunched about every 30 seconds. That contradicted this section, and a repeatedly relaunching
> Python process from removable media can by itself raise an endpoint-protection alert. The current
> version does not start it at all unless Npcap is present and capture is approved, as described
> above. If an alert was raised during an earlier run, it may have been this.

---

## 5b. Huginn's own "Enumerate" — opt-in, one target at a time, no external tools

Huginn has a per-device **Enumerate** button that does a deeper look using **only Huginn's own code**
(no nmap, no installed scanner — this is why it works off the USB stick anywhere). On the one device the
operator picks, it:
- runs a **TCP connect scan** of a set of common ports (our own code, same harmless `connect()` as the
  Odin sweep, just more ports, on one host);
- for each open port, does a **read-only service probe**: grab whatever banner the service sends; for a
  web port, a single `GET /` to read the status, `Server` header and page title; for a TLS port, read the
  certificate (subject, issuer, names, dates);
- asks the host to identify itself via **UPnP/SSDP** (the standard device-description request) and a
  **NetBIOS node-status** query (UDP 137 — how Windows machines volunteer their computer name).

Every one of these is reconnaissance a device answers willingly. There are **no** logins, password tries,
default-credential guesses, exploits, or writes of any kind — it reads banners, headers, certificates and
self-descriptions and stops there. Like the Deep look it is **opt-in, one target at a time, local address
only** (a public address is refused), and runs only when a human clicks it on a device they are cleared to
probe. It is read-only and changes nothing on the target.

Because it does active probing of a host, EDR may flag it as a scan — correctly, it is one, aimed at a
single authorized device. That is expected; run it only where you are allowed.

## 5a. The optional "Deep look" (nmap) — opt-in, one target at a time

Huginn has a per-device **Deep look** button that runs **nmap** against a single device the operator
picks, to list its open ports and identify the service and version on each (e.g. "OpenWrt uHTTPd" on
port 80). This is the one feature that does active service/version probing, so it is treated carefully:

- **It is opt-in and manual.** It never runs on its own and is never part of the automatic sweep. A
  human clicks it, on one device, on purpose.
- **It is not bundled.** nmap is **not** shipped with the kit. The button only appears if nmap is already
  installed on the machine; otherwise the feature does not exist. Whether it is available is therefore
  your decision (don't install nmap, and it's off).
- **It can only target a device on the local network.** The target is validated to be a private/LAN
  address that Huginn is already watching. A public/internet address is refused, so this cannot be used
  to scan anything outside the network you authorized.
- **The scan is deliberately modest:** a TCP connect scan (`-sT`, no admin needed, no raw packets),
  light version detection (`-sV --version-light`), the top ~200 common ports, one host, with a timeout.
  OS fingerprinting (`-O`) is off unless explicitly requested and only works with admin.
- **One at a time**, and it changes nothing on the target — it reads which ports answer.

This is louder than the rest of the kit and **will** look like a scanner to EDR, because it is one, aimed
at a single host. Run it only on devices you are cleared to probe. If you would rather it not exist on
managed machines, simply don't install nmap on them.

## 6. For the CrowdStrike / EDR team: what may trip, and why it is benign

A monitoring tool does some of the same things a scanner does, so a few detections are expected. Here is
what to look for and the exception to consider, once you have decided to allow it:

| You may see | From | Why it is benign | Narrow exception |
| --- | --- | --- | --- |
| A host sweeping its subnet with ICMP, then short TCP connects to ~10 ports | `python.exe` running `odin/app.py` | Discovery of its own lab subnet, connect-scan only, fixed small port list | Allow this signed Python image, running from the kit path, this network range |
| The kit's `python.exe` running `sniffer.py` and opening a packet-capture handle (Npcap) | Huginn's capture helper, started only when Npcap is installed **and** capture is switched on for the kit (section 5) | Standard Npcap, non-promiscuous, metadata only | Only if you approve capture: allow the kit's `python.exe` (by hash, from the kit path) to use Npcap. Otherwise leave Npcap off and nothing is started |
| PowerShell enumerating processes, services, tasks, Run keys, signatures | Muninn's `collect.ps1`, run as admin by the student | Read-only inventory; it changes nothing | Allow this script by hash/path; it never writes outside its folder |
| `node.exe` connect-scanning one host's common ports, then GET/TLS/UDP(137,1900) probes to it | the opt-in **Enumerate** (Huginn's own code), when a human clicks it | Manual read-only recon of a single authorized device; no logins, no exploits | Allow `node.exe` from the kit path; it only ever targets one local address at a time |
| A connect scan of ~200 ports on **one** host, with service/version banners | the opt-in **Deep look** (nmap), only if nmap is installed and a human clicks it | Manual recon of a single authorized device; connect scan, no exploits | Decide per policy; leaving nmap uninstalled disables it entirely |
| Portable `python.exe` / `node.exe` launched from removable media | The kit's own runtimes | Unsigned-by-you but official builds (section 9 lists versions and hashes) | Allow by hash, from the kit path |

None of these involve code injection, process hollowing, LSASS or credential access, token manipulation,
persistence, or outbound C2: the behaviors EDR is actually built to stop. If you watch the kit live, that
absence is the clearest signal that it is what it claims to be.

If your policy is "nothing new runs on managed endpoints, full stop," that is a completely reasonable call;
in that case the student can run the kit from a single non-managed PC plugged into the lab network instead,
and it still maps everything. It only needs to run on a machine you are willing to let it run on.

---

## 7. What you control

- **The subnet and the port list:** `odin/config.json`.
- **Whether it pings the internet at all:** off by default in lab mode.
- **Whether packets are read:** by choosing whether to install Npcap.
- **Whether the Deep look (nmap) exists at all:** by choosing whether to install nmap. No nmap, no button.
- **Which machines Muninn runs on:** only the ones someone runs it on, as admin, on purpose.
- **Scope and time:** it is a folder on a stick. It runs when double-clicked and stops when closed. There
  is no service, no scheduled task, no auto-start.

The kit also asks the student, on first run, to confirm they have written permission and to record who
gave it, before it scans anything.

---

## 8. Data handling

- **Collected:** a list of devices (address, hardware address, open ports, maker), this PC's own traffic
  metadata (if Npcap is on), and per-machine Muninn inventories.
- **Stored:** only on the USB stick, in the kit folder.
- **Sent off the machine:** nothing. There is no cloud, no account, no telemetry, no upload.
- **Retention:** the traffic history auto-deletes after 7 days; everything else is deleted when the
  student deletes the folder, or whenever you ask.
- **Personal data:** none is sought. It records device and server names, not anyone's files, messages,
  keystrokes, or passwords.

---

## 9. How to verify all of this yourself

1. **Read the source.** It is all plain text: `odin/*.py`, `huginn/command/*.js` and `huginn/lib/*.js`,
   `muninn/*.ps1`. The whole project is on the student's GitHub; nothing is obfuscated or compiled by us.
2. **Confirm the runtimes.** The portable Node and Python are the official builds from nodejs.org and
   python.org. The student can give you the exact versions and SHA-256 hashes to match against the vendors'
   published checksums.
3. **Watch it run.** Put it on a test VM, point your own EDR and a packet capture at it, and confirm it
   does exactly what sections 2–5 describe and nothing else.
4. **Check the binds.** `netstat -ano` will show Huginn and Odin listening on `127.0.0.1` only.

The point of handing you this document, and the source, is that you should not have to take anyone's word
for it. If anything here does not match what you observe, that is a bug we want to hear about.

---

*Student project. The goal is to learn how a network and its hosts can be made visible, safely and in the
open, with the network owner's knowledge and consent.*
