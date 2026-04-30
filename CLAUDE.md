Scope: Repo-specific. Inherits from org CLAUDE.md (`a2fbaab5`). Adds conventions specific to the `brain3-companion` Android-companion application. On any conflict, follow the inheritance order in the org doc: org → repo → ticket-level direction.

## Repo Purpose

`brain3-companion` is the Android-only companion app for BRAIN. Stream C of Phase 2 builds it out from a near-empty repo to a full notification-driven companion that talks to BRAIN's API. Sideload-only distribution; no Play Store presence.

## Framework & Pinned Versions

- **Ionic React** v8.x
- **Capacitor** 6.x — do NOT upgrade to 7+ without explicit decision
- **React** 18.2 — do NOT upgrade to 19 without explicit decision
- **Vite** (current)
- **TypeScript** with `tsconfig.moduleResolution: Bundler`
- **TanStack Query** for async state
- **Tailwind CSS** for styling

CLI defaults may have drifted past these versions — honor the pin, not the default. `npm create @ionic/react-app@latest` will install whatever's current; the package.json pins are the contract. ([2C-10] PR #27 D-3 is precedent: CLI installed Capacitor 8 + React 19, was downgraded to 6.x + 18.2 to honor the pin.)

## Platform Scope

Android-only for v2.0.0. iOS parity deferred to a future release. Do not add iOS platform, iOS-specific code paths, or iOS-conditional logic. Per Pass 1 E1.

## Build Environment

**Default shell: Windows cmd.exe.** L's primary dev environment is Windows. All build commands target Windows shell by default. Cross-platform variants are deferred to a polish ticket — do not add them speculatively.

- Use `.\gradlew.bat` not `./gradlew` (POSIX `./gradlew` does not parse on Windows). ([2C-11] PR #28 D-1 is precedent.)
- Path separators: backslash in shell commands.

**Required environment variables** (must be set in shell before running Gradle commands):
- `JAVA_HOME` — pointing at JDK install
- `ANDROID_HOME` — pointing at Android SDK install

If these aren't set, `npm run android:build:debug` and any Gradle command will fail with cryptic errors. See `android/keystore/README.md` for full setup. ([2C-11] PR #28 D-3 is precedent.)

**Android SDK pin:** `buildToolsVersion = "35.0.0"` in `variables.gradle`. The SDK install lives in Program Files which is read-only — do not assume the build can write to the SDK directory. ([2C-11] PR #28 D-2 is precedent.)

## Distribution Model — Two Channels

- **Dev channel (experimental):** GitHub Actions workflow on push to `develop` builds debug APK and publishes to GitHub Releases as a pre-release tagged `develop-{short-sha}`. Auto-prune to last 10. Sideload via the GitHub mobile app on device. Established by [2C-15] PR #30.
- **Release channel (formal):** Manual via release ceremony on `main`. L-generated release keystore signs locally; tag pattern `v{semver}`. Documented in `docs/RELEASE.md`. The release keystore stays local-only — never committed, never in CI.

**Package name:** `com.fluxmeridian.brain3companion`. Per Pass 3 O-4. Do not change this.

### Pre-Install APK Verification

Before sideloading any APK to a physical device or AVD, verify it is the build you intend by opening it in Android Studio's **Build → Analyze APK…** view and inspecting `assets/capacitor.config.json`. The `plugins` block in that file is byte-identical to whatever `npm run android:sync` produced at build time, and is therefore the canonical answer to "which fix-version does this APK contain." This check takes ~15 seconds and short-circuits the entire class of "wrong APK installed, mistaken for the right one" debugging cost.

The GitHub Releases page is **not authoritatively chronological** — pre-releases may visually appear out of order due to tag-creation timing or filtering. To find a known-good build, do not trust visual top-of-list. Match the short SHA of the commit you want (e.g., a PR merge commit) to its release tag (`develop-{short-sha}`) and navigate directly via tag URL: `https://github.com/WilliM233/brain3-companion/releases/tag/develop-{short-sha}`.

For a second axis of confirmation when desired: `certutil -hashfile <apk> SHA256` against the local download.

**Source precedent:** [2C-Bug-05] AVD diagnostic dispatch 2026-04-30 (Stellan Report `c4fd5034` §1.3, §3, §6.2(a) is canonical). Pre-#48 APK was sideloaded in mistake for post-#48 because Releases visual order was non-chronological; APK Analyzer of `assets/capacitor.config.json` was the dispositive check that broke the diagnostic stall.

## Network Posture — Two Layers

Network posture has two layers, both of which must be configured for cleartext HTTP to work in this app:

1. **Native HTTP transport.** `capacitor.config.ts` must enable `CapacitorHttp: { enabled: true }` so that JS `fetch()` and `XMLHttpRequest` are routed through native Java HTTP rather than through the WebView. Without this, the WebView's mixed-content policy blocks any HTTP fetch from the default `https://localhost` origin before NSC is ever consulted.
2. **NSC posture.** `android/app/src/main/res/xml/network_security_config.xml` declares `<base-config cleartextTrafficPermitted="true">` for v2.0.0 (LAN-only HTTP). When TLS lands, tighten via the NSC base-config.

Do **not** add `android:usesCleartextTraffic` to the manifest. Do **not** change `server.androidScheme` (it stays `'https'`). Do **not** rely on `server.cleartext` (which only affects the dev-server live-reload connection, not runtime fetch behavior in a built APK).

The two layers are independently necessary: PR #46 (NSC alone) was structurally correct but blocked at runtime because layer 1 was missing. PR #48 (CapacitorHttp enable) closed the gap.

**Source precedent:** Stellan Reports `0bec116d` (NSC architecture) + `0351faa0` §6.1 (two-layer expansion).

## Build-Asset Provisioning — Firebase

Push notifications require `android/app/google-services.json`. The file is **gitignored** (contains a Firebase API key + project IDs that should not live in source) and is **CI-injected at build time** rather than committed.

CI mechanism (in `.github/workflows/dev-release.yml`):
1. Repo secret `GOOGLE_SERVICES_JSON_BASE64` holds the base64-encoded JSON.
2. A workflow step between "Install npm dependencies" and "Build web bundle" decodes the secret to `android/app/google-services.json`.
3. The same step runs `grep -q '"project_id"' android/app/google-services.json` and exits 1 (failing the build loudly) if the file is missing or malformed.

The `grep` guard exists because `android/app/build.gradle:63-70` wraps `apply plugin: 'com.google.gms.google-services'` in a try/catch that **silently skips** plugin application when the JSON is absent — producing a successful build with non-functional push notifications. The CI guard closes that silent-skip surface.

**Local development without Firebase setup:** The try/catch silent-skip path is intentional for the new-contributor case where push notifications are not yet wired. Do not remove it. The CI guard is what enforces correctness for builds that are distributed.

**Source precedent:** [2C-Bug-05] Stellan Report `605869fa` §2.2 (silent-skip mechanism), §4.1 (CI inject pattern). Filed as fix-3 in PR #51.

## Android Sync Structural Guard

`npm run android:sync` regenerates `android/app/src/main/assets/capacitor.config.json` and other Capacitor-managed Android resources from `capacitor.config.ts` and the JS-side plugin metadata. The TS source is the source of truth; the regenerated JSON is a build-time artifact that **must be committed alongside source-side changes** to keep the working tree coherent.

The class of drift this section prevents: a JS-side `npm install` adds a Capacitor plugin (e.g., `@capacitor/device@6.0.3` in commit `3d6ef44` of [2C-05]), but `npm run android:sync` is not run in the same commit — so the Android side never registers the plugin. The next Android build silently lacks the native shim and runtime calls fail in non-obvious ways.

**Rule:** Any commit that adds, removes, or upgrades a Capacitor plugin MUST be paired with the regenerated `android/` artifacts in the same commit (or an immediately-following commit on the same branch). The PR body's "Changes" section should explicitly note that `android:sync` ran clean.

**CI guard (deferred):** A repo CI step that runs `npm run android:sync` and fails if `git diff --exit-code android/` produces a non-empty diff would catch this class of drift mechanically. Filed as enhancement against this convention; not yet implemented. See issue `[2C-Gap-02]` (#49) for the precedent and one-line CI step suggestion.

**Source precedent:** [2C-Gap-02] (issue #49) — `@capacitor/device@6.0.3` added to JS but never synced into android gradle, surfaced during Bug-04 fix-2 dispatch when the missing native shim caused a follow-on diagnostic.

## Pre-PR Verification Gates

Beyond the org-level lint + unit-test requirement: brain3-companion has compile-only and runtime-environment failure modes that pure-JS gates cannot catch. Two CI-layer protections close this gap:

1. **Dev Release workflow runs PR-triggered, not just push-triggered.** When a PR is opened against `develop` (or any branch with the dev-release workflow attached), the full Android Gradle build runs. This catches compile-only failures (Bug-02 firebase-messaging classpath, Bug-03 MainActivity.onDestroy access modifier) before merge rather than after. Recommended over requiring `npm run android:build:debug` as a contributor-side gate, which would force every contributor to maintain a working JDK + ANDROID_HOME setup.
2. **Build-asset content checks (described above):** APK provenance check (Pre-Install APK Verification), Firebase secret guard (Build-Asset Provisioning), Android sync structural guard.

**Runtime-layer gate (manual):** P-8b sub-shape (runtime-environment failures invisible to CI) is closed not by CI but by the manual on-device acceptance gate in the v2.0.0 release runbook. See Deployment Reference `6de85be0` §7 for the canonical six-criterion MV procedure: provenance + outcome + mechanism. Release ceremony cannot proceed past the manual gate.

**Source precedent:** P-8 (post-merge bug discovery) — three instances in Stream C Group 2 (Bug-02, Bug-03, Bug-04). P-8a (CI-surfaceable) closed by PR-trigger; P-8b (runtime-environment) closed by manual on-device gate. Amendment #5a + #5b from Group 2 close.

## Test Conventions

**Tests are co-located with the module they test.** Pattern: `src/lib/foo.ts` → `src/lib/foo.test.ts`. Do NOT introduce new files in `tests/unit/` — that directory is being phased out. Existing tests in `tests/unit/` will migrate as their modules are touched. ([2C-12] PR #29 D-1 + PR #33 follow-up are precedent.)

Run tests with `npm run test.unit`. Tests must be independent — no ordering dependencies. Use mocks/fixtures for external dependencies (Capacitor plugins, BRAIN API).

## Lint & Format

`npm run lint` must pass clean before opening any PR. Foundation PRs that introduce new top-level directories (e.g., `android/`) must update `eslint.config.js` ignores in the same PR — do not leave repo-wide lint failures for follow-up tickets to clean up. ([2C-12] PR #29 D-4 is precedent for the cleanup, codified going forward.)

## Asset Conventions

**App icons + splash screens:** SVG sources are committed to the repo. Raster assets (PNG, WebP) are generated from SVGs via `sharp` (devDep) using the npm script. Future icon/splash work edits the SVG, runs the regen script, commits both the SVG source and the regenerated rasters. Do not hand-edit raster assets. ([2C-14] PR #34 D-3 is precedent.)

`@capacitor/assets` v3 is the primary tooling for adaptive icons. Legacy `ic_launcher.png` is filled by a custom backfill script for older Android API levels — `@capacitor/assets` v3 doesn't produce it. ([2C-14] PR #34 D-1 + D-2 are precedent.)

## GitHub Actions

Prefer single-line semicolon/comma-delimited strings for package lists in YAML over multi-line forms. Multi-line YAML lists carry parse ambiguity risk — `android-actions/setup-android` is a known case ([2C-Bug-01] PR #32 is precedent). When in doubt, single-line wins.

## File Structure (post-Group 1)

```
brain3-companion/
├── android/                      # Capacitor Android platform
│   ├── keystore/                 # Debug keystore + setup README
│   ├── app/build.gradle          # buildToolsVersion, deps
│   └── variables.gradle          # SDK version pins
├── src/
│   ├── lib/                      # Modules + co-located tests
│   ├── pages/                    # Route components
│   └── App.tsx
├── docs/
│   └── RELEASE.md                # Two-channel distribution docs
├── eslint.config.js
├── package.json                  # Pinned versions — do NOT bump silently
├── tsconfig.json                 # moduleResolution: Bundler
└── vite.config.ts
```

## npm Scripts

- `npm run dev` — Vite dev server
- `npm run build` — production build
- `npm run lint` — ESLint over all source
- `npm run test.unit` — Vitest unit tests
- `npm run android:sync` — sync web build to Android platform
- `npm run android:build:debug` — build debug APK
- `npm run android:open` — open in Android Studio

## Stream C Specifics

Group 1 = client foundation (✅ complete as of 2026-04-27). Group 2 = server + notification loop (the v2.0.0 DoD gate, ✅ complete as of 2026-04-30). Groups 3 + 4 build out habit/routine/rule surfaces and offline hardening. The Stream C Running Dispatch Checklist (`3da63076`) is the live state document — read it for current ticket status.

Stream C tickets: the **filed GitHub issue body is the canonical contract.** Each issue has Scope, Acceptance criteria, Out of scope, Technical notes, Dependencies, References. Some include a `#### Manual verification` section — preserve verbatim on merge; L runs the MV procedures, agent does not. If the issue body has no MV section, no MV obligations apply for that ticket. Auto-verifiable tickets are valid without MV.

## Deviation Handling

If during implementation the spec proves incorrect (e.g., a CLI command in Technical notes doesn't work as described, a tool default drifted past a pinned version, a path doesn't exist), resolve the deviation while honoring the spec's intent and flag it in the PR body. Do NOT silently fix and move on — the deviation log is how BRAIN learns the spec landed wrong. The PR template's Deviations section is the contract.

---
Updated: April 30, 2026. v2: Five amendments from Stream C Group 2 close. (1) New "Pre-Install APK Verification" subsection under Distribution Model — codifies APK Analyzer + GitHub Releases ordering trap (amendment #10, source: Stellan Report `c4fd5034`). (2) New "Network Posture — Two Layers" section — codifies CapacitorHttp + NSC two-layer requirement (amendment #7, source: Stellan Report `0351faa0` §6.1). (3) New "Build-Asset Provisioning — Firebase" section — codifies CI-injected google-services.json with grep guard (amendment #9, source: Stellan Report `605869fa` §4.1). (4) New "Android Sync Structural Guard" section — codifies pairing JS plugin changes with regenerated android/ artifacts (amendment #8, source: [2C-Gap-02] issue #49). (5) New "Pre-PR Verification Gates" section — Dev Release workflow PR-trigger + manual MV gate pointer to Deployment Reference §7 (amendment #5a + #5b context, source: P-8 close from Group 2). Stream C Specifics updated to mark Group 2 complete. v1 → v2 also satisfies amendment #4 (CLAUDE.md repo-state housekeeping) — this is the canonical BRAIN version that working copies should sync from.
Created: April 27, 2026 (v1).
Source: extracted from Desmond Brief Stream C Group 1 v3 (`4bc64b07`) settled decisions + post-merge precedents from PRs #27, #28, #29, #30, #32, #33, #34. Drift root cause: brain3-companion repo had no CLAUDE.md through Group 1 implementation; conventions accumulated in the brief instead of the repo. Closing the gap so future Stream C groups read CLAUDE.md for conventions and the brief for group-level framing.

Companion: org CLAUDE.md v6 (`a2fbaab5`) covers CHANGELOG-at-version-cut + first-consumer-instantiates rule. Companion: brain3 CLAUDE.md v3 (`cf7fc00c`) covers migration sequencing rule.
