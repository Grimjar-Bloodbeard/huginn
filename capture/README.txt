PUT THE NPCAP INSTALLER HERE

Huginn's live packet view (the moving sparks) needs a capture driver called Npcap.
We cannot ship Npcap (its free licence does not allow redistributing the installer),
so you add it once:

  1. On a PC that is allowed online, go to https://npcap.com and download the installer
     (it is free for a few machines).
  2. Copy the downloaded npcap-<version>.exe into THIS folder.
  3. From the kit folder, run Enable-Capture.bat (as administrator). It checks the file,
     shows its SHA-256 so you and IT can verify it against npcap.com, and runs the official
     signed installer. Then Start.bat shows the live sparks.

A capture driver is a kernel driver. On a managed PC this is the step most likely to be
blocked by endpoint protection. Get it approved first; do not try to work around it.
Huginn works without Npcap; only the live packet sparks are off.
