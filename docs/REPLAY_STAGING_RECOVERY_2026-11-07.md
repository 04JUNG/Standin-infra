# Staging replay recovery — 2026-11-07

The running staging BFF used `NODE_ENV=production` without a `REPLAY_ENVIRONMENT`
override. Replay defaults to assumed authorization, which is rejected outside development
and staging. The dashboard surfaced `REPLAY_AUTHORIZATION_DENIED` (HTTP 403).

Applied only to staging:

- CloudFormation change set `replay-storage-20261107-v2`: added `ReplayBucket99CF29EB`,
  `ReplayBucketPolicy4A5E93B0`, and `ReplayAccess25E0FAC2`. No existing resources modified.
- Added BFF replay configuration: `REPLAY_ENVIRONMENT=staging`, `REPLAY_ENABLED=true`,
  `REPLAY_CONSENT_MODE=assumed`, `CAPTURE_REPLAY_ENABLED=true`,
  `CSP_RESULT_CAPTURE_ENABLED=true`, and `REPLAY_BUCKET` pointing to the new bucket.
- Rolled BFF task definition from revision 110 to 111, preserving the deployed image digest
  `sha256:3bcff4b5a18adbf0913e765f162aaa3595f55c1f1c49e7d1b30304b50b32616e`
  and all non-replay task settings. Other services were not redeployed.

Verified authenticated `GET /v1/admin/replays` and `/v1/admin/replays/facets` return HTTP 200.
The default list had zero items at verification time; actual playback of a recorded session
was not verified. Verified the bucket's 30-day expiration and AES256 encryption, and simulated
the BFF role's list/get/put/delete permissions successfully. The production CloudFormation
template is unchanged. Subsequent BFF deployment workflows copy the active task definition,
so they preserve these replay variables.

The infrastructure change defines separate staging and production controls. Production is
default-off and uses explicit consent. Desktop release builds also have separate
`STAGING_REPLAY_ENABLED` and `PRODUCTION_REPLAY_ENABLED` repository variables. After merging,
activate production on both server and client as described in the README. Staging activation
never grants production authorization.
