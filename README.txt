RAVENS KIT
Odin's Watch maps the network. Muninn checks each computer. Huginn shows it all.

BEFORE YOU START
Get written permission from whoever runs the network. Scanning a network you don't
run, even gently, can break its rules and sometimes the law.

START
1. Double-click Start.bat. The first time, it asks you to confirm you have permission
   and who gave it (kept in site\huginn.config.json for your records).
2. The first time, it finds this PC's network (for example 10.20.30.0/24) and maps it.
   Huginn opens in the browser at http://127.0.0.1:33613
3. Close the black window to stop.

Everything stays in this folder: settings in site\, Huginn's memory in site\huginn-data\,
Odin's map in odin\. Nothing is installed on the PC. Both dashboards answer this PC only.

CHANGE THE NAME OR THE NETWORK
site\huginn.config.json   "siteName": "Room 214 lab"
odin\config.json          "subnets": the networks to map (cidr like 10.20.30.0/24)

LIVE PACKET SPARKS (the moving packets)
Huginn shows the map and everything else with no driver. The live sparks (this PC's own
packets moving on the map) need a capture driver called Npcap. To turn them on:
  1. Download Npcap once from https://npcap.com (free for a few machines) and copy the
     npcap-<version>.exe into the capture\ folder on this stick.
  2. Run Enable-Capture.bat as administrator. It checks the file, shows its SHA-256 so you
     and IT can verify it against npcap.com, then runs the official signed installer.
  3. Start.bat from then on shows the live sparks.
Npcap is a kernel driver, so on a managed PC this is the step endpoint protection is most
likely to block. Get it approved first (the for-IT\ folder explains it). Without Npcap,
everything else still works. We cannot bundle Npcap: its licence does not allow it.

MUNINN (checking a computer)
muninn\ is the host audit kit. Put Microsoft Sysinternals (Process Explorer, TCPView,
Autoruns) in muninn\tools\, then on the computer to check: right-click
muninn\run-collect.bat, Run as administrator. Read muninn\reports\<time>\FLAGS.txt.
It collects and flags. It never deletes or kills anything.

WHAT'S IN HERE
Start.bat          start everything
Enable-Capture.bat turn on the live packet sparks (installs Npcap; admin, optional)
capture\           where you drop the Npcap installer
kit\               the launcher
huginn\       the command center
odin\         Odin's Watch
muninn\       Muninn
runtime\      portable Node and Python (optional; the PC's own are used if missing)
site\         made on first run: this site's settings, logs and data
