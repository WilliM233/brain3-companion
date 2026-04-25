# Releases — brain3-companion

`brain3-companion` ships through **two distribution channels**. Both produce sideloadable Android APKs — neither involves the Play Store.

| Channel | Branch | Trigger | Signing | Stability | Audience |
|---|---|---|---|---|---|
| **Dev** (experimental) | `develop` | Auto on push (CI) | Project debug keystore (gitignored, regenerated on demand) | "Latest changes — may break" | L + internal collaborators wanting the bleeding edge |
| **Release** (formal) | `main` | Manual ceremony | L-held release keystore (off-repo, password-protected) | "Tested, intentional milestone" | L + any sideloader on the formal channel |

The dev channel is the heartbeat — every merge to `develop` produces an installable APK so L can put it on the test device within minutes. The release channel is the milestone — manual, deliberate, properly versioned, signed with material that never touches CI or git.

---

## Dev channel (experimental)

### How it works

GitHub Actions workflow at [`.github/workflows/dev-release.yml`](../.github/workflows/dev-release.yml) fires on every push to `develop`. It:

1. Checks out the commit
2. Installs Node 20, JDK 17 (Temurin), and the Android SDK (`platforms;android-34`, `build-tools;35.0.0`)
3. Regenerates the debug keystore via the documented `keytool` command (the keystore itself is gitignored — see [`android/keystore/README.md`](../android/keystore/README.md))
4. Builds the web bundle (`npm run build`)
5. Syncs Capacitor (`npx cap sync android`)
6. Builds the debug APK (`./gradlew assembleDebug`)
7. Publishes a **pre-release** to GitHub Releases with:
   - Tag: `develop-{short-sha}` (e.g., `develop-a35e43c`)
   - Title: `Dev build {short-sha} ({yyyy-mm-dd})`
   - Asset: `app-debug.apk`
   - Notes: source commit link + commit subject
8. Prunes older `develop-*` pre-releases, keeping only the 10 most recent

### What a dev pre-release means

> "Every check that was green on the merged PR is still green here, and the APK builds clean from a fresh checkout."

It does **not** mean: "L has used this end-to-end on hardware." The `pre-release` flag in GitHub is the signal — these are intentionally not the formal versioned release.

### Installing a dev pre-release

See [Sideloading instructions](#sideloading-instructions) below — same procedure for both channels.

---

## Release channel (formal)

The release channel is intentionally **manual**. The release keystore stays local-only — it does not live in CI, in environment secrets, or in this repo. This is a deliberate trust-boundary decision: only L can sign a formal release. The cost is a few minutes of ceremony per release; the benefit is that there is no pathway by which an automated process can produce something marketed as a "formal release."

### Per-release ceremony

Run from a clean local checkout. Steps below assume the release keystore already exists (see [Generating the release keystore](#generating-the-release-keystore) for the one-time setup).

#### 1. Bump the version

Edit two files in lockstep:

- `package.json` — bump the `version` field (semver: `MAJOR.MINOR.PATCH`, e.g., `2.0.0`)
- `android/app/build.gradle` — bump `versionName` (matches `package.json`) and increment `versionCode` by exactly 1 (Android requires a strictly increasing integer)

Commit on `develop`:

```sh
git checkout develop
git pull origin develop
# edit package.json + android/app/build.gradle
git add package.json android/app/build.gradle
git commit -m "chore: bump version to 2.0.0 (#XX)"
git push origin develop
```

(Replace `#XX` with the release-cut tracking ticket if one exists.)

#### 2. Update the changelog

Add a section to `CHANGELOG.md` summarizing what shipped since the previous release. Reference the relevant tickets and PRs. Commit as part of the version bump or as a follow-up.

#### 3. Open a release PR: `develop` → `main`

```sh
gh pr create --base main --head develop \
  --title "Release v2.0.0" \
  --body "Promote develop to main for v2.0.0 release. See CHANGELOG.md for what shipped."
```

Review the diff. Merge when satisfied.

#### 4. Pull `main` locally

```sh
git checkout main
git pull origin main
```

#### 5. Build and sign the release APK

The release keystore lives outside this repo. Provide its location and passwords via shell environment for the build only — never commit them, never echo them into shell history that's saved.

```sh
export RELEASE_KEYSTORE=/secure/path/to/brain3-companion-release.keystore
export RELEASE_KEY_ALIAS=brain3-companion-release
export RELEASE_KEY_PASSWORD='<from password manager>'
export RELEASE_STORE_PASSWORD='<from password manager>'
```

Then either sign during Gradle build or sign post-build with `apksigner`. Both produce the same artifact; pick whichever is less friction.

**Option A — sign during Gradle build.** Add a temporary `signingConfigs.release` block to `android/app/build.gradle` that reads the env vars above (do **not** commit this change), then:

```sh
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease     # macOS / Linux
# or on Windows:
cd android && .\gradlew.bat assembleRelease
```

**Option B — sign post-build with `apksigner`.** Build unsigned, then sign separately:

```sh
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease     # produces app/build/outputs/apk/release/app-release-unsigned.apk

apksigner sign \
  --ks "$RELEASE_KEYSTORE" \
  --ks-key-alias "$RELEASE_KEY_ALIAS" \
  --ks-pass env:RELEASE_STORE_PASSWORD \
  --key-pass env:RELEASE_KEY_PASSWORD \
  --out app/build/outputs/apk/release/app-release.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk

apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Option B keeps signing material entirely out of any tracked Gradle file, at the cost of one extra command.

#### 6. Tag the release

```sh
git tag -a v2.0.0 -m "Release v2.0.0"
git push origin v2.0.0
```

Tag pattern: `v{semver}` (e.g., `v2.0.0`, `v2.0.1`, `v2.1.0-beta.1`).

#### 7. Create the GitHub Release

```sh
gh release create v2.0.0 \
  android/app/build/outputs/apk/release/app-release.apk \
  --title "v2.0.0" \
  --notes-file CHANGELOG-v2.0.0.md
```

Use a per-release notes file (extracted from `CHANGELOG.md`) or paste the relevant section inline via `--notes`. Do **not** pass `--prerelease` — that flag is reserved for the dev channel.

#### 8. Verify on device

Sideload the release APK to the test device using the steps below. Smoke-test the v2.0.0 DoD criteria before announcing.

---

## Generating the release keystore

Run this **once**, locally, when establishing release-signing for the project. The output file is the only thing standing between this project and someone else publishing updates that install over the legitimate ones on existing devices — treat it accordingly.

```sh
keytool -genkeypair -v \
  -keystore brain3-companion-release.keystore \
  -alias brain3-companion-release \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -storetype PKCS12
```

`keytool` will prompt for:

- A keystore password (store in your password manager — losing this means losing the ability to ship updates that install over previous releases)
- A key password (use the same as the keystore password unless you have a specific reason not to)
- Distinguished name fields (CN, O, etc.) — answer truthfully; these end up in the certificate

### Where to keep it

- **Not in this repo.** Even gitignored — store it physically outside the working tree to prevent accidents.
- **Backed up.** At least one offline copy (encrypted USB, password manager attachment, etc.). Lose the keystore and v2.0.0 → v2.0.1 will refuse to install over v2.0.0 on every existing device.
- **Password in a password manager.** Not in plain text, not in shell history, not on a sticky note.

### Keystore loss recovery (worst case)

If the release keystore is lost or compromised:

1. Generate a new keystore with a new alias.
2. Bump the version to a new major (e.g., v2 → v3).
3. Document in the release notes that existing v2 users must uninstall before installing v3 — there is no signature-compatible upgrade path.
4. File a permanent reference issue documenting the keystore reset so future agents see the history.

This recovery is painful by design. The pain is what motivates not losing the keystore in the first place.

---

## Sideloading instructions

Both dev and release APKs sideload the same way. There is no Play Store distribution.

### One-time device setup

1. On the device: **Settings → Apps → Special access → Install unknown apps**
2. Pick the browser or file-manager app you'll use to open the APK
3. Toggle **Allow from this source** on for that app

(Path may differ slightly between Samsung One UI and stock Android. Search "install unknown apps" if it's hidden somewhere else.)

### Installing an APK

1. Open the GitHub Releases page on the device's browser:
   - Latest dev pre-release: <https://github.com/WilliM233/brain3-companion/releases?q=prerelease%3Atrue>
   - Latest formal release: <https://github.com/WilliM233/brain3-companion/releases/latest>
2. Tap the `app-debug.apk` (dev) or `app-release.apk` (release) asset to download
3. Open the downloaded APK from notifications or the file manager
4. Confirm install when Android prompts

### Installing alongside an existing version

Android refuses to install a different-signed APK over an existing one with the same package name (`com.fluxmeridian.brain3companion`). This means:

- Switching between **dev** and **release** channels on the same device requires uninstalling first (data loss).
- Reinstalling within the **same** channel is fine — the keystore matches.

For active development on a single device, pick a channel and stay on it. To run both side by side, dedicate two devices (or two emulator instances).

### Updating

Check the [Releases page](https://github.com/WilliM233/brain3-companion/releases) periodically. There is no in-app update mechanism for v2.0.0 — that is an interesting future feature, intentionally deferred.

---

## What this document does NOT cover

- **Play Store publishing** — deferred per Phase 2 design decisions (Pass 1 E1, E2). Sideload-only is the supported distribution mode.
- **iOS releases** — Android-only for v2.0.0. iOS parity is additive in a later phase.
- **Release-channel automation** — formal releases stay manual on purpose. CI never sees the release keystore.
- **OTA / in-app updates** — not supported in v2.0.0. Users check the Releases page.

---

_See [`android/keystore/README.md`](../android/keystore/README.md) for debug-keystore details, and ticket `[2C-15]` for the rationale behind the two-channel model._
