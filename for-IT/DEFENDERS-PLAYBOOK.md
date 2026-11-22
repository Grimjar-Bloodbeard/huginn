# Defender's Playbook — spotting backdoors and stopping attacks with Huginn

**For:** whoever is watching the network with this kit (you, in the lab, with permission).
**What it is:** a short, repeatable procedure for *noticing* that something is wrong and *responding*
with the tools Huginn already has. Everything here is detection and response. Nothing here attacks,
exploits, or reaches outside the network you were cleared to watch.

**The one rule that comes first:** have written permission from whoever owns the network before you
run any of this on a lab. Watching traffic and scanning hosts is a real action, even when it only reads.

---

## The loop

Every alert follows the same four steps. Don't skip ahead — a contained machine you didn't confirm
is just a machine you took offline for no reason.

1. **Notice** — something is off (Huginn surfaces it, or you spot it on the map).
2. **Confirm** — prove it's real before you act (Enumerate / Host check).
3. **Contain** — cut the one thing off, change nothing else (Quarantine zone).
4. **Recover** — decide what happened, clean it, write it down.

---

## 1. Notice — where the warnings come from

Huginn is already watching for the shapes an intrusion makes. Each of these is a screen you can check.

| Sign something is wrong | Where Huginn shows it | Why it matters |
| --- | --- | --- |
| A device you've never seen joined the network | **Devices** list — new entry; **Unusual** flags it | An attacker's own machine, or a rogue dropbox, shows up as a new host |
| A known device is suddenly talking to a brand-new site | **Unusual** → *new sites* | Malware calling home (command-and-control) looks like a device reaching a domain it never used before |
| Traffic at an hour nothing should be awake | **Unusual** → *odd hour* | Backdoors beacon on their own schedule, often overnight |
| A short, sharp burst of connections | **Unusual** → *bursts* | Scanning, spreading, or exfiltration moves in bursts |
| A device has a port open that it shouldn't | **Enumerate** on that device | A listening port nobody set up is the classic shape of a backdoor (a reverse shell, a planted service) |
| A PC's process or startup list looks wrong | **Host check** (Muninn) flags | Persistence — the thing that re-launches the backdoor after reboot — lives in startup items and services |

**Tune out the normal first.** Open **Unusual** on a quiet, known-good day and tap *normal* on the
things that are just how your network behaves (the printer's mDNS chatter, a laptop's update server).
After that, what's left on the list is worth a look. An alert you've learned to ignore protects nobody.

---

## 2. Confirm — is it actually a backdoor?

Before you cut anything off, prove the finding. Two read-only tools do this, one network-side and one
host-side.

### A backdoor on the network: **Enumerate** the suspect device

Open the device's sheet and hit **Enumerate** (Huginn's own scanner — no external tools, runs off the
stick). It connect-scans that one host and reads back, without logging in:

- **Which ports are open** — compare to what that kind of device *should* have. A webcam serving SSH,
  or a desktop listening on a high random port, is the tell.
- **The banner / HTTP identity / TLS certificate** on each open port — what's actually answering.
  A real service names itself (a printer's web page, a router's firmware). A backdoor often answers
  with nothing, a raw shell, or a certificate that doesn't match the device.
- **What the device says it is** (UPnP/SSDP, NetBIOS name) — and whether that matches reality.

**Backdoor tells to look for:**
- A listening port that corresponds to no service you installed, especially a high/odd one.
- A port that's open but whose banner is empty or looks like a command prompt.
- A service whose version/identity doesn't match the hardware (a "router" answering as a Linux shell).
- The same unexpected port open on *several* machines — that's a worm or a pushed implant, not a fluke.

### Persistence on a PC: **Host check** (Muninn)

Muninn is a read-only audit of one Windows machine's processes and startup items. In the device sheet,
**Host check** shows its flags. Backdoors survive reboots by hooking persistence, so look for:

- A startup item or scheduled task you don't recognize, especially one pointing at a temp folder,
  a user profile, or a script instead of a known program.
- A process running from an unusual path, or a signed-looking name in the wrong place.
- A service that was added recently and matches the port Enumerate flagged.

Enumerate found the *door*. Host check finds *what props it open*. Together they turn "this looks
weird" into "this is a backdoor on port X, launched by Y at startup" — which is what you need before
you touch anything.

---

## 3. Contain — cut off the one thing, break nothing else

You have one lever that's safe, reversible, and doesn't need anyone's firewall: the **Quarantine
zone** (Pi-hole groups, only if there's a Pi-hole on the network).

- Move the suspect device into **Quarantine**. That group blocks *all* DNS for that device — it can't
  resolve its command-and-control server, so the backdoor goes deaf even though the machine is still on.
- Huginn **previews** the change and lets you **undo** it. Quarantine only ever touches that one
  device's own group — it can never spill onto the default policy for everyone else.
- This is a containment step, not a fix. DNS blocking stops the beaconing; it does not remove the
  implant. Keep the machine quarantined until it's cleaned.

**If there's no Pi-hole,** containment is physical or administrative: pull the device off the network
(unplug / disable the port / remove from wifi) and tell whoever owns it. Don't improvise a block you
can't undo, and don't change a firewall or switch you weren't given the keys to.

**What *not* to do** — this kit is a watcher, and so are you while you use it:
- Don't try to log into, exploit, or "test" the backdoor. Reading its banner is confirmation; touching
  the shell is an intrusion, even against the attacker's own tool.
- Don't delete logs or files on the suspect machine before someone who owns it has looked.
- Don't widen a DNS block past the one device.

---

## 4. Recover — close it out

1. **Write down** what you saw, in order: the alert, what Enumerate and Host check showed, the time.
   Screenshots from the sheets are enough. (This is also your evidence that the kit did its job.)
2. **Clean the host** — removing the backdoor and its persistence is a host job (reimage, or remove the
   service/startup item and the port it opened). The owner or IT does this; the kit's role was to find it.
3. **Re-check** — after the clean, Enumerate the device again. The flagged port should be gone. Only
   then take it out of Quarantine, and watch Unusual for a day in case it comes back.
4. **Learn the baseline back in** — once the device is genuinely clean, tap its now-normal behavior as
   *normal* in Unusual so the next real alert stands out.

---

## Fast reference

| You see… | Do this |
| --- | --- |
| Unknown device appears | Enumerate it → identify or isolate it |
| Known device → new/odd domain | Check Unusual; if it's not explained, Quarantine and investigate the host |
| Unexpected open port | Enumerate to read the service → Host check for the launcher → Quarantine |
| Startup/service you don't know | Host check flag → correlate with an open port → hand to the host owner |
| Burst of connections at 3 a.m. | Quarantine the source, then confirm what it was reaching |
| You're not sure it's real | **Confirm before you contain.** Enumerate and Host check cost nothing but a minute |

---

*This playbook uses only Huginn's existing read-only features (Devices, Unusual, Enumerate, Host check)
and its one reversible control (Quarantine zone, Pi-hole only). It adds no new capability and no new
risk beyond what the IT security review (`IT-SECURITY-REVIEW.md`) already describes.*
