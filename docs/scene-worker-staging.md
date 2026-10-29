
## Isolated rollout when the AppStack has drift

`bin/scene-worker.ts` is a separate CDK app. It creates only
`StandinStagingSceneWorker` and imports the existing staging VPC, cluster,
namespace, BFF security group, assets bucket and VLM secret by explicit identity.
It never synthesizes the existing AppStack/Registry/Cicd resources or deploys
production. Validate the operator context against AWS before using it, with
public/isolated subnet arrays ordered to match availabilityZones. Do not use
both the original AppStack worker construct and this stack for the same resources.

```sh
npx cdk --app 'npx ts-node --prefer-ts-exts bin/scene-worker.ts' diff StandinStagingSceneWorker \
  -c stagingSceneContext=/operator/staging-infra-context.json \
  -c stagingSceneWorkerConfig=/operator/staging-scene-worker.json
```

Deploy the exact reviewed standalone assembly with desiredCount 0, then follow
the image/publication/readiness sequence above. Existing AppStack drift is not
silently reconciled. BFF connection must preserve the current task definition,
images, initializers, unrelated environment and secrets, modifying only the scene
URL/token/timeout/refinement flag after private readiness and a fresh smoke pass.
Back up the previous task ARN and roll back to it if real save verification fails.
