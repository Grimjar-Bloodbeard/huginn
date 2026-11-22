# Huginn

Huginn is a local, read-only map of a network you run on your own machine. It shows
the router, the devices on your network, and the traffic your own PC sends and
receives, as a live picture you can explore. It never changes, blocks or deletes
anything on the network - it only watches and shows.

## Start it

Double-click `Start.bat`. The first time, it asks you to confirm you have permission
to watch this network and who gave it, then finds the network this PC is on and opens
Huginn in your browser.

## Safety

- Huginn binds to `127.0.0.1` only. The dashboard answers this PC and nothing else.
- It makes no outbound internet connections. Everything stays on your machine.
- It is read-only: it observes, it never alters the network.

## Permission

Only run Huginn on a network you own, or one you have written permission to watch.
Scanning a network you do not run - even gently - can break its rules and, in some
places, the law. If in doubt, do not run it.
