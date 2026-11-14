# Confirmed Mac update host

This Python standard-library service publishes metadata for one privately prepared iOS release. An authenticated `POST /v1/install` creates a durable confirmation valid for ten minutes. The background worker may retry a busy renewal lock, an unavailable paired phone or a locked phone during that window. Checking status, starting the host without a saved confirmation, and dismissing an app alert never install a release.

The host does not fetch source, build, sign, renew profiles, access an Apple account or run a command supplied over HTTP. Apple tools only verify and install an already signed local app. Existing automatic renewal remains a separate service and shares its `run.lock` with this host.

## Private setup

Use `/opt/homebrew/bin/python3` or another current Python 3 installation on macOS. Keep the real configuration, token, TLS private key, manifests, prepared signed packages, immutable source snapshots, state and logs outside this repository. Examples contain placeholders only.

1. Copy `config.example.json` to a private directory, fill its fixed target identity and absolute paths, and set permissions to `0600`. Keep the containing directory private (`0700`). `renewalConfigPath` must point to the existing private native renewal configuration; its state directory supplies the shared lock and installed receipt.
2. Generate a dedicated update token containing 32–256 printable ASCII characters without whitespace. Put only that token in the private `accessTokenPath` file (`0600`). This must be a separate credential from the photo service.
3. Configure a private CA and a TLS certificate for the exact local hostname used by the app. Keep the certificate key private (`0600`). The app's private `AppUpdateHost.json` separately contains this CA's DER certificate, exact HTTPS API root, host ID and dedicated token. Normal CA/name validation and pinning remain required. The host serves HTTPS only and never redirects.
4. Prepare and sign the main app and its single share extension, including the approved private `LocalServerIdentity.json`. Publish the private manifest only after the package and source snapshot are final. Their paths must stay stable while a release is advertised or confirmed.
5. Run the check below. It validates the configuration, token, TLS key/certificate and prepared package; it does not contact or install onto a phone. Then adapt the LaunchAgent template to your private paths and register it using your normal local deployment procedure.

```sh
/opt/homebrew/bin/python3 /absolute/path/update_host.py --config /absolute/private/config.json --check-config
/opt/homebrew/bin/python3 /absolute/path/update_host.py --config /absolute/private/config.json
```

`config.example.json` shows the exact schema (no additional fields). `listenHost` is a local bind address; use a reachable LAN address or `0.0.0.0` when the paired phone should connect over Wi-Fi. `hostId` is an opaque non-secret identifier. The device, team, bundles, group and approved enrollment digest are set by the Mac owner and cannot be changed by a request. The Mac must be awake and logged in. The paired phone must be reachable through Xcode device services, with any necessary unlock/pairing already completed. Both `localNetwork` and `wired` paired transports are accepted; receipts record the observed transport.

The LaunchAgent template sets `DEVELOPER_DIR` to the full Xcode installation so `xcrun devicectl` is available even when the shell selects Command Line Tools. Adjust this path if Xcode is installed elsewhere.

## Manifest and digests

`release.example.json` shows all required private fields. `build` is a string matching `CFBundleVersion`; `version` matches `CFBundleShortVersionString`. Both must match the main app and share extension. The signed main app's `Info.plist` must also contain `MJoraSourceRevision` equal to `sourceRevision`; stamp it before signing. `releaseId` must identify one immutable prepared package. `sourceRevision` is its reviewed source revision, represented by 40 or 64 lowercase hexadecimal characters.

Import `update_host.py` to compute these helpers without starting the server:

- `tree_sha256(app_path)` sorts every relative path, then hashes each regular file as UTF-8 relative path, NUL, file contents, NUL. It rejects symlinks and special files. It includes all signed-package files, including generated files.
- `source_fingerprint(source_root)` follows the native renewal helper's existing exclusions exactly: `.git`, generated Xcode/build state, workspaces and `.DS_Store` are excluded; `Package.resolved`, `.xcscheme`, `.xcconfig` and `.xcsettings` stay pinned. This value becomes the helper's `source_sha256` after a successful install.
- `target_identity_sha256(config)` hashes compact sorted JSON containing only `appGroup`, `deviceUDID`, `mainBundleId`, `shareBundleId` and `teamId`. Put it in `targetIdentitySHA256` to bind the approved package to the fixed target configuration.
- `enrollmentSHA256` is SHA-256 of the exact bytes of the built app's `LocalServerIdentity.json`. It must also match `approvedEnrollmentSHA256` in the host configuration. This preserves the existing photo server enrollment. It is independent of the new update host CA/token configuration.

The host rejects a changed package, changed source fingerprint, wrong enrollment, mismatched main/share identity or version, wrong team/group/device, unsupported Wi-Fi entitlement, invalid signature, expired profile or either profile expiring earlier than the installed baseline. Equal existing profile expirations are allowed: a version update does not claim to renew signing validity. An invalid or expired package is hidden from `status.latest`; Apple sign-in/profile repair must happen separately.

## API and worker

Both endpoints require `Authorization: Bearer <dedicated-token>`; comparison uses `hmac.compare_digest`. Responses never include paths, device IDs, signing profiles, certificate material, token values or command output.

`GET /v1/status` returns:

```json
{"schemaVersion":1,"hostId":"example-host","latest":{"releaseId":"release-1.0.1-2","version":"1.0.1","build":"2","notes":"Prepared update"},"installation":{"state":"idle"}}
```

`latest` is `null` if the prepared package is unavailable or invalid. Installation states are `idle`, `queued`, `installing`, `succeeded`, `failed`; optional fields are `releaseId` and `messageCode`. Public message codes are `needsPhone`, `needsUnlock`, `signInRequired`, `invalidPackage`, `busy`, `failed`.

`POST /v1/install` accepts exactly this JSON shape, with a UUID request ID and a body at most 2 KiB:

```json
{"releaseId":"release-1.0.1-2","requestId":"b4c8146b-d071-4eb1-9c56-f827bb80d02a"}
```

It returns `202 {"state":"queued","releaseId":"release-1.0.1-2"}` after validating the package while holding the native renewal lock and persisting confirmation. Paths, URLs, commands, certificates, device identifiers, unknown fields and duplicate JSON keys are rejected. A request ID is durably bound to one release. Retrying that ID returns the same acceptance without extending its deadline or starting another install. A completed or expired confirmation is never rearmed. Use a new UUID only for a new explicit user confirmation. One job can be active at a time; a second daemon is rejected using `host.lock`.

The worker rechecks the confirmed manifest digest and package under the shared renewal lock. It queries only the configured phone and main bundle before installation, requires the app already be installed, installs using a fixed argument list, checks the exact reported version/build afterward, and revalidates the local package/source/profiles. Only then does it update the native renewal configuration's `source_root` and `source_sha256`, preserving project, derived-data, cache and app paths. It records both profile UUIDs/expirations in native `success.json` and adds version/source provenance in `update-provenance.json`. After successful verification it also merges any existing `source-provenance.json` beside the native renewal configuration, updating `sourceRevision` and `pinnedSHA256` (and an existing `sourceSHA256`) while preserving local overrides, helper and dependency metadata. These receipts describe a confirmed version update, not a renewal.

The local confirmation journal is private state, not a remote command queue. Do not hand-edit or move it between hosts. If the daemon restarts with a valid saved confirmation, it may resume that job; after ten minutes it requires a fresh user confirmation. An install already started before the deadline may finish afterward. Unexpected terminal failures are reported as `failed` and require a new confirmation. At most eight request handlers can be active. TLS handshakes run inside those handlers, so accepting a new socket does not wait for a handshake. Each connection has one absolute ten-second shutdown deadline covering its handshake, headers, body and response; header progress cannot extend it. A closed connection retains its handler permit until any already running validation finishes. Raw HTTP input and Apple tool output are never logged; the host logs fixed state/message codes only.

## Offline verification

```sh
python3 -m unittest discover -s /absolute/path/update-host -p 'test_*.py' -v
```

Tests use synthetic plists, fake Apple tools and a temporary private filesystem. They cover the confirmation boundary, restart/idempotency/expiry, shared lock, package and source digests, signature/profile/identity checks, readiness and post-install receipt safeguards. They do not contact a device or prove a future-version installation on a real phone. Actual HTTPS trust, pairing, device version reporting and installation still require local integration verification.
