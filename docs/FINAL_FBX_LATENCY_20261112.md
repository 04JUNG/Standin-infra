# Staging final FBX latency reduction

Observed staging requests spent 53.7–54.5 seconds preparing a final FBX; Converter execution was 49.9–50.7 seconds with effectively zero queue wait. One airborne plantar correction/search report recorded 19.85 seconds. PNG preparation followed separately (6.6–7.1 seconds).

## Changes

1. **Private persistent verified-byte cache.** Existing exact-input cache now persists receipts/FBXs in staging S3. A task restart or a different job can reuse the exact validated artifact. Only the operator-registered library BVH hashes and registered character hashes are eligible. Source/shape/hand/scope/camera/runtime-policy changes produce distinct identities; refined and uploaded private BVHs remain uncached globally. Every BFF request still performs its normal job ownership/current selection checks. No job receipt is shared.
2. **Per-search immutable geometry reuse.** Airborne candidate evaluation reuses rest weights, ROI topology, rest areas/edges and adjacency. All posed mesh, clearance, fold, joint, selector and final FBX reimport checks still run. Contexts are not shared across imports, shape changes, jobs or final baking. The opt-in switch is `CONVERTER_REUSE_REST_METRICS=1`; absence/0 runs the existing path.

The frozen parent/retarget code and all safety thresholds are unchanged. The V3.2.5 manifest now pins the changed airborne caller and the new rest-surface helper; protocol/fixture hashes are updated together. This is not a whole-body collision certificate.

## Initial evidence

- Blender 5.2.0/fbe6228777e7: all metric fields exactly matched on neutral, mildly deformed, folded, degenerate, missing-weight and degenerate-rig cases with 141,561 vertices.
- Isolated four-evaluation measurement: 4.046s baseline vs 1.984s including reusable context construction. This is **not** a full export latency benchmark; see rest-metrics-20261112.json.
- Staging service-level first-export/reuse timings must be recorded after the reviewed image is deployed. A new combination still requires one full verified conversion; this change does not promise instant first export for every library pose.

## Storage, registration and rollout

Raw 620MB library bytes were audited inside an isolated staging ECS task. Its complete archive SHA256 matched the currently deployed library (71d764a6e5bf62b2baffd45f990b9be56d6e7fdb5907ec62eafcc751336f2506); only checksums were returned. The pinned control registry has 3,501 distinct BVH hashes and 71 character hashes from the verified current Converter registry. There are 3,503 pose IDs (two byte-identical BVHs deduplicate).

- Operator controls: `verified-final-control/library-<sha>.json` and `verified-final-control/revoked.json`, read-only to the Converter.
- Data: `verified-final-data/v1/`, Converter gains PutObject only under this prefix. Bucket remains private; AES256 object encryption, no ACL or bucket policy changes.
- Receipts/revocations are refreshed from S3; large FBXs are not accumulated on task disk. Publish artifact bytes first, then its receipt. Corrupt/stale/revoked/unavailable cache falls back to the existing worker.
- `config/staging-final-cache.json` is the operator pin shared with infra. Refresh its input registry when the approved library/model catalog changes; unregistered new inputs safely miss until then.
- Develop Converter deployment applies `prepare_staging_final_cache.py`; main/production is untouched. Apply the scoped staging write grant before enabling persistence. Full CDK deployment is unnecessary for this rollout.
- `CONVERTER_FINAL_CACHE_ENABLED=0` staging workflow variable disables persistence. `CONVERTER_REUSE_REST_METRICS=0` disables immutable geometry reuse independently. Automatic full-library prewarming stays off to avoid a multi-day batch competing with users.
