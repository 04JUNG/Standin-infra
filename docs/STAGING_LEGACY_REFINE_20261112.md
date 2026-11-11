# Staging legacy refine rollback — 2026-11-12

Staging uses the existing `/refine` solver (code version v2.5.4), not `/refine/release` (RC4).

| Service | Settings |
| --- | --- |
| BFF / analysis-worker | `REFINE_RELEASE_ENABLED=0`, `REFINE_FEATURE_ENABLED=true` |
| Inference | `REFINE_RELEASE_ENABLED=0`, `REFINE_ENABLED=1`, `REFINE_V2_ENABLED=1`, `REFINE_DEFAULT_MODE=aggressive`, `REFINE_V25_SELECTOR_ENABLED=1` |

The aggressive candidate still requires the safety/non-regression selector; rejected candidates fall back to conservative/base. This is not a guarantee against all actual mesh defects.

Deploy policy is staging-only. GitHub `staging` environment variables override these defaults deliberately; `beta`/production variables are not changed. Workflow task-definition preparation preserves images, roles, secrets, body assets, hand flags and sidecars. Existing workflows also inherit the patched live task definition before these source guards merge.

The RC4 sidecar stays idle to preserve the current dependency/health wiring. Its own internal readiness flag is not the public feature gate: both callers (BFF and inference) are off. Removing it is separate cleanup. Analysis-worker stays scaled to zero.

Existing RC4 job artifacts are not converted by disabling a flag. Restart the selection flow/new work to verify legacy refinement. No app installer rebuild is needed for the server capability change.

Production is outside this rollout. Promoting v2.5.4 to production later requires reviewed server code promotion to main and explicit matching runtime policy; a flag cannot upgrade an older production image. Do not deploy the entire CDK stack just to apply these flags: other runtime wiring must first be reconciled.
