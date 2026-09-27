# Building and releasing Flightboard Studio

`.github/workflows/build.yml` builds three packages on every push and pull request, and turns a version tag into a
GitHub release.

| Build        | Runner           | Output                                            |
| ------------ | ---------------- | ------------------------------------------------- |
| macOS arm64  | `macos-15`       | `flightboard-studio-<version>-mac-arm64.dmg`      |
| macOS x64    | `macos-15`       | `flightboard-studio-<version>-mac-x64.dmg` (cross-built on Apple silicon) |
| Windows x64  | `windows-latest` | `flightboard-studio-<version>-win-x64-setup.exe`  |

- **Every push / PR**: the version is the package version as a prerelease, `1.0.0-ci.<run>.g<sha>`. The packages are
  attached to the workflow run (Actions → the run → Artifacts, kept 14 days).
- **Tag `vMAJOR.MINOR.PATCH`** (or `v1.2.0-rc.1`): the same builds with that version, then a GitHub release with the two
  DMGs, the Windows installer and `SHA256SUMS.txt`, and generated release notes. A tag with a `-suffix` makes a
  prerelease. A `v…` tag that is not semver fails the run. `package.json` does not need a bump: the tag is the version.

```bash
git tag v1.0.0
git push origin v1.0.0
```

Each build also bundles the Altium generator: `scripts/publish-pcbgen.sh <rid>` publishes `../pcbgen` self-contained
for that platform (osx-arm64, osx-x64, win-x64) and electron-builder copies it and the template into the app.

## One-time setup

### 1. Repositories

- **flightboard-studio**: push it to GitHub. The workflow is in this repo.
- **pcbgen**: its own repository, checked out next to the studio in CI. By default `<same owner>/pcbgen`. Otherwise set
  the repository variable `PCBGEN_REPOSITORY` (Settings → Secrets and variables → Actions → Variables), e.g.
  `koiosdigital/pcbgen`. `PCBGEN_REF` picks a branch or tag (default branch when unset); pin it to a tag for
  reproducible releases.
  - The repository has `gen/` (sources), `patches/`, `tools/`, `template-snapshot/`, `tests/`, the scripts and the
    README. The `.gitignore` leaves out `bin/`, `obj/`, `out/`, `AltiumSharp/`, `Plane_Template.zip` and `template/`.
  - `template/` holds the live Altium 365 checkouts (each with its own `.git`). The app bundles the design files of
    `template/Plane_Template` when it exists (your Mac) and `template-snapshot/Plane_Template` otherwise (CI). After
    changing the template in Altium, run `tools/snapshot-template.sh` in pcbgen and commit the snapshot.
  - AltiumSharp is not committed: `tools/altiumsharp.sh` clones upstream at a pinned commit (with the two shared EDA
    submodules) and applies `patches/altiumsharp.patch`, our changes. After changing AltiumSharp locally, refresh the
    patch with `tools/altiumsharp.sh --update-patch` and commit it.
  - If pcbgen is **private**, the workflow's own token cannot read it. Create a fine-grained personal access token
    with *Contents: read* on the pcbgen repository and save it as the secret `PCBGEN_TOKEN` in the studio repository.

### 2. macOS signing: a Developer ID certificate

Without it the macOS builds are ad-hoc signed: fine on your own Mac, but other Macs refuse to open them.

- Distribution outside the Mac App Store needs a **Developer ID Application** certificate. Your keychain has
  *Apple Development* and *Apple Distribution* identities only; neither works for this.
- Only the team's **Account Holder** can create one. Pick the team (Koios Digital LLC `9R8RREG67J` or Terranova Systems
  `KU3979CKH2`), then in Xcode: Settings → Accounts → the team → Manage Certificates → + → *Developer ID Application*.
  (Or developer.apple.com → Certificates → + → Developer ID Application, with a CSR from Keychain Access.)
- Export it **with its private key** from Keychain Access (My Certificates → right-click → Export → .p12, with a
  password) and add two repository secrets:
  - `MAC_CERT_P12_BASE64`: `base64 -i DeveloperIDApplication.p12 | pbcopy`, then paste
  - `MAC_CERT_PASSWORD`: the export password

### 3. macOS notarization: an App Store Connect API key

Without it the builds are signed but not notarized, and Gatekeeper still warns on first launch.

- App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**. Access:
  *Developer*. Download `AuthKey_<KEYID>.p8` (it can be downloaded only once).
- Repository secrets:
  - `APPLE_API_KEY_P8`: the contents of the .p8 file (`pbcopy < AuthKey_XXXXXXXXXX.p8`)
  - `APPLE_API_KEY_ID`: the key ID (10 characters)
  - `APPLE_API_ISSUER`: the Issuer ID shown above the key list (a UUID)

With all five macOS secrets set, the workflow signs with the Developer ID, notarizes and staples, and the run's
"Check the macOS signature" step prints Gatekeeper's verdict (`accepted source=Notarized Developer ID`).

### 4. Windows (optional)

The installer is not signed: SmartScreen shows "Windows protected your PC" (More info → Run anyway). Signing needs
Azure Trusted Signing or an OV/EV code-signing certificate; not set up.

## Local builds

```bash
pnpm build:mac:local   # arm64 DMG, ad-hoc signed
pnpm build:mac:x64     # x64 DMG, cross-built, ad-hoc signed
pnpm build:mac         # signed with a keychain identity (needs a single Developer ID Application certificate)
pnpm build:win         # Windows installer (run on Windows)
pnpm art               # regenerate build/icon.* and the DMG background
```
