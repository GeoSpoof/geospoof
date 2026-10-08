# Security Policy

Thanks for helping keep GeoSpoof and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** A public report can
tell an attacker how to defeat the protection before a fix ships — and because
GeoSpoof is a privacy tool, that can mean exposing the real location a user is
trying to keep private.

Report privately instead, using GitHub's private vulnerability reporting:

1. Go to the [**Security** tab](https://github.com/GeoSpoof/geospoof/security) of
   this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version, and steps to reproduce.

This opens a private advisory visible only to the maintainers. You'll get a
response as soon as possible — typically within a few days. If a fix is
warranted, we'll coordinate a release and credit you in the advisory unless you
prefer to remain anonymous.

## What's in scope

- The browser extension's injected script and its API overrides (Geolocation,
  `Date`, `Intl`, `Temporal`, Permissions, WebRTC).
- The build pipeline and release/signing workflow in this repository.
- The CDN that serves timezone data and the self-hosted update manifest.

## Known limitations (not vulnerabilities)

GeoSpoof spoofs from a **content script**, and some detection vectors cannot be
fully closed from that context. These are documented, not bugs, and are described
in `docs/BACKGROUND.md` under "Limits of Extension-Level Spoofing":

- The `document_start` init race before overrides are installed.
- Engine-internal brand checks and `SharedArrayBuffer` / high-resolution timing
  side-channels.
- Cross-origin iframes and Web Workers the content script cannot reach.

A report showing a _new_ way around the protections we do claim — or an
inconsistency a real fingerprinting script could exploit — is very much in scope.
A report that simply restates one of the limitations above is not, though we're
always glad to discuss them.

## Supported versions

Only the latest released version receives security fixes. Users on the
self-hosted Firefox build and the store listings are expected to auto-update; see
`README.md` for installation and update details.
