MUNINN v1 — home lab audit kit
One of Odin's ravens: flies out, remembers what it saw, reports back. Not a cleaner.
Windows 10/11 flashlight.

USE
1. Copy this whole folder to a 32GB USB stick.
2. On the stick, put official Sysinternals in tools\
   Process Explorer, TCPView, Autoruns
   Official source only: Microsoft Sysinternals.
3. Plug the stick into the target Windows PC.
4. Right-click run-collect.bat -> Run as administrator.
5. Read reports\<timestamp>\FLAGS.txt
6. If something looks wrong, open tools\procexp64.exe and Autoruns.
7. Suspend or uncheck. Do not delete on the first pass.

RULES
- This machine and your other lab PC only.
- Collect and flag. Do not auto-kill.
- If Autoruns entries come back after reboot, that is persistence. Stop and think.

FOLDERS
collect.ps1      gather evidence
triage.ps1       mark unsigned / bad path / odd startup
run-collect.bat  one-click admin launch
tools\           Sysinternals binaries you add
reports\         created on first run
