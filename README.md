# brain3-companion

Companion app for [BRAIN 3.0](https://github.com/WilliM233/brain3) — the ADHD-aware personal operating system. Capacitor-based Android app (iOS parity additive later); notification surface for habits, routines, rules, and check-ins.

Phone + Samsung Galaxy Watch (Wear OS) are the reference surfaces for v2.0.0. Sideload-signed APK distribution (no Play Store).

## Status

Pre-implementation. Chunk 2 of Stream C (the notification loop) is the v2.0.0 DoD gate. Canonical spec lives in BRAIN (artifact `aef015b8-6ae2-4f45-bdd5-2da204d814de`); ticket specs live in BRAIN (artifact `778e95c9-53c9-4807-ad04-739317bf5fa6`) and as issues on this repo tagged `phase-2`.

## Tech stack

- [Ionic React](https://ionicframework.com/docs/react) v8
- [Capacitor](https://capacitorjs.com/) 6 (Android-only for v2.0.0)
- [Vite](https://vitejs.dev/) 5
- [TypeScript](https://www.typescriptlang.org/) 5 (strict mode)
- [TanStack Query](https://tanstack.com/query/latest) v5 (installed; provider wired in `[2C-12]`)
- [Tailwind CSS](https://tailwindcss.com/) 3.4 (Flux Meridian palette tokens)

## Prerequisites

- **Node.js** 20 LTS or newer (`.nvmrc` pins to 20). `node --version` should print `v20.x` or higher.
- **Android Studio** (Iguana or newer) — required for native builds, signing, and emulators. See [Capacitor Android setup](https://capacitorjs.com/docs/android).
- **JDK 17+** — bundled with current Android Studio; verify via `java --version`.

## Quick start

```bash
# install dependencies
npm install

# start the dev server (PWA at http://localhost:5173)
npm run dev

# production web build (writes to dist/)
npm run build

# unit tests
npm run test.unit

# lint
npm run lint
```

After the Android platform is added in `[2C-11]`, the native sync flow is:

```bash
npm run build
npx cap sync android
npx cap open android
```

## Releases

`brain3-companion` ships through two distribution channels:

- **Dev** (experimental) — auto-built on every push to `develop` by [`.github/workflows/dev-release.yml`](.github/workflows/dev-release.yml). Published as a GitHub **pre-release** tagged `develop-{short-sha}`. The 10 most recent dev pre-releases are kept; older ones are pruned automatically. Treat these as "every check is green and the APK builds clean" — not as hand-tested formal builds.
- **Release** (formal) — manual ceremony on `main`, signed with L's release keystore (off-repo, password-protected). Tagged `v{semver}`.

See [`docs/RELEASE.md`](docs/RELEASE.md) for the full two-channel model, the release ceremony, keystore handling, and sideloading instructions. All builds — both channels — are sideload-only; no Play Store distribution. Browse all builds on the [Releases page](https://github.com/WilliM233/brain3-companion/releases).

## Project layout

```
src/
  pages/        # top-level route components
  components/   # shared UI primitives
  lib/          # framework-agnostic client code (API, storage, types)
  theme/        # Ionic CSS variables + Tailwind base
public/         # static assets (favicon, manifest)
capacitor.config.ts
tailwind.config.ts
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

_Part of [Project Flux Meridian](https://fluxmeridian.com)._
