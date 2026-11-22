# Ravens Kit — bundled runtimes and their hashes

So IT can confirm the kit carries unmodified official builds. Match these against the vendors' own
published checksums (linked), then against the files on the stick (`runtime\`).

## Portable runtimes (official builds, carried on the stick)

| Component | Version | File | SHA-256 |
| --- | --- | --- | --- |
| Node.js (LTS) | 26.13.0 | `node-v26.13.0-win-x64.zip` | `dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a` |
| Python (embeddable) | 3.13.17 | `python-3.13.17-embed-amd64.zip` | `9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38` |

- Node checksums (official): `https://nodejs.org/dist/v26.13.0/SHASUMS256.txt`
- Python checksum (official): on the 3.13.17 release page at python.org, the *Windows embeddable
  package (64-bit)* download.

Verify a file on the stick (PowerShell):
```
Get-FileHash H:\runtime\node\node.exe -Algorithm SHA256
```
(The table hashes are of the original vendor .zip; the stick holds the extracted contents. To match the
exact zip, re-download from the vendor and hash that, or hash the extracted files against a fresh extract.)

## Python packages (installed from PyPI into the kit's Python)

- `flask` (>=3.0), `zeroconf` (>=0.130), `scapy` — all installed as official PyPI wheels.

## Node packages (Huginn)

Huginn has **one** runtime dependency:

| Package | Version | Integrity (from package-lock.json) |
| --- | --- | --- |
| `web-push` | 3.6.7 | `sha512-OpiIUe8cuGjrj3mMBFWY+e4MMIkW3SVT+7vEIjvD9kejGUypv8GPDf84JdPWskK8zMRIJ6xYGm+Kxr8YkPyA0A==` |

`web-push` is used only for phone notifications at home; it is not used in the lab (no phone, no
subscription). The rest of `node_modules` are its sub-dependencies, all pinned in `package-lock.json`.

## Browser-side

- UI fonts (Schibsted Grotesk, JetBrains Mono) are vendored locally under
  `huginn/command/public/fonts/` (SIL Open Font License). The page loads them from Huginn, not the
  internet, and a Content-Security-Policy blocks any other source.
- The 3D view uses three.js **0.186.1**, vendored under `huginn/command/public/vendor/three/`.
