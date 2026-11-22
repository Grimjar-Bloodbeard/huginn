# Muninn

Muninn is an optional, read-only Windows host audit. It collects process, network,
startup and service evidence from a single machine and flags the odd items for a
human to review - it never kills, deletes or changes anything.

Run its collect script (`run-collect.bat`) as Administrator on the machine you want
to check, then read the newest `FLAGS.txt` it writes. Only run it on machines you own
or have written permission to audit.
