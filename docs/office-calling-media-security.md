# Office Calling media-security posture

Status: Phase 7 engineering decision

## Current truthful claim

Office call signaling and Agora media are encrypted in transit. The product must
not claim that Office Calls are end-to-end encrypted like WhatsApp.

The current design does not implement a reviewed end-to-end key agreement. The
application server authorizes participants and mints Agora access tokens; Agora
remains part of the trust boundary. Enabling one static SDK encryption password
would not fix device authentication, per-call forward secrecy, multi-device key
distribution, rotation, compromise recovery or verifiable safety numbers.

## Decision

- Keep application-layer Agora media encryption disabled for this release.
- Never log, persist or expose future media keys in diagnostics, push payloads,
  URL parameters, analytics or crash reports.
- User-facing security copy is exactly: “Encrypted in transit.” Do not add
  “end-to-end encrypted”, “WhatsApp encryption” or equivalent wording.
- The feature remains beta until the Phase 8 signed-device matrix passes.

## Required design before any E2EE claim

1. Per-installation identity keys stored in Secure Enclave/Keychain on iOS and
   Android Keystore on Android; a reviewed equivalent is required for web.
2. Authenticated per-call ephemeral key agreement with participant/device
   verification, replay protection and forward secrecy.
3. Multi-device fan-out, device revocation, account recovery and key rotation
   that cannot silently add an unauthorized endpoint.
4. Media-frame encryption support and interoperable test vectors on web, iOS
   and Android, including reconnect and token renewal.
5. Independent cryptographic design/code review, threat model, penetration test,
   key-compromise drill and written approval of the exact user-facing claim.

Until all five are proven, Agora transport security is useful protection but is
not WhatsApp-style end-to-end encryption.
