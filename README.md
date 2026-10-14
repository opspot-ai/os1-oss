# OS1

OS1 is an experimental phone interface for a local agent workspace. A Node.js bridge serves a Progressive Web App and connects it to configured agent, voice, and note-capture features. An optional SwiftUI iOS client uses the same bridge.

## Components

- pwa/server/proxy.mjs is the Node.js bridge; pwa/public/ contains the web app.
- ios-native/ contains the SwiftUI client and XcodeGen project description.
- LICENSE contains the MIT license and its copyright notice.

## Run the web app

Requires Node.js 18 or later. The bridge declares no npm package dependencies.

From the repository root:

    npm --prefix pwa start

The bridge serves the web app on port 8787 by default. When OS1_BACKEND is unset and no remote-computer backend credentials are supplied, it selects demo mode. This command reads environment variables from the shell; it does not load .env.

For the local agent CLI backend, copy .env.example to .env, set OS1_BACKEND=local, configure the paths and CLI settings for your machine, then run:

    pwa/scripts/run-local.sh

That script reads the root .env, creates a bridge token file if needed, and starts the bridge on port 8788 by default. The local backend also invokes the configured agent CLI and uses sqlite3 and rg from the host.

## Configuration

The .env.example file lists bridge, local agent, OpenAI, and optional remote-computer settings. It contains default settings, empty credentials, and generic placeholders; it has no real keys or host-specific endpoints. Realtime voice and note transcription require an OpenAI API key. ios-native/Config/Local.xcconfig.example shows the native client's URL, token, signing-team, and bundle-ID settings. After configuring the bridge, generate the local file and Xcode project from ios-native:

    scripts/bootstrap-config.sh
    scripts/generate-project.sh

XcodeGen is required for project generation.

## Known limitations

This is an as-is experimental snapshot. Runtime behavior, builds, and tests have not been verified for this release. The bridge defaults to listening on 0.0.0.0; an empty OS1_ACCESS_TOKEN disables API authentication. Do not expose it to an untrusted network without changing those settings.

The local backend expects a compatible agent CLI and database schema. The optional orgo backend is incomplete: its sessions, Kanban, and files routes currently return empty results. Native project generation uses XcodeGen. Building, device signing, and installation require a suitable Xcode setup and are unverified. The included iOS UI-test source was not run.
