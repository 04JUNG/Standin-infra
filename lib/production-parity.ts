/** Product parity with the approved develop runtime; no staging endpoints or credentials. */
import { Stack } from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { readFileSync } from "node:fs";
import path from "node:path";
const profile = JSON.parse(readFileSync(path.join(__dirname, "../config/production-runtime-parity.json"), "utf8"));
export function configureProductionParity(task: ecs.FargateTaskDefinition, assets: s3.Bucket,
  role: "inference" | "bff" | "analysis-worker" | "converter", token: secretsmanager.ISecret, replay: s3.Bucket, converterImage?: ecs.ContainerImage) {
  const main = task.findContainer(role);
  if (!main) throw new Error("missing production serving container");
  const uri = (key: string) => `s3://${assets.bucketName}/${key}`;
  const add = (env: Record<string, string>) => { for (const [k,v] of Object.entries(env)) main.addEnvironment(k,v); };
  if (role === "inference") {
    add({BODY_MATCHING_MODE:"off", HAND_SKIN_SCREEN_CONCURRENCY:"2", HAND_SKIN_SCREEN_ON_SELECTION:"1",
      SEMANTIC_REVIEWED_PROPS_FIRST:"1", POSE_LIBRARY_VERSION:profile.poseLibraryVersion, POSE_LIBRARY_URI:uri(profile.poseLibraryKey),
      POSE_THUMBNAIL_OVERLAY_URI:uri(profile.thumbnailKey), POSE_THUMBNAIL_OVERLAY_SHA256:profile.thumbnailSha256,
      ROUTING_FULLBODY_ENABLED:"1", ROUTING_PREPARE_ASSETS:"1", ROUTING_LUNA_SIX_FIELD_ENABLED:"1",
      POSE_BACKEND:"rtmlib", POSE_MODEL_VARIANT:"humanart-m", POSE_CANARY_STAGE:"canary-100",
      POSE_STRICT:"1", POSE_CALIBRATION_FROM_MANIFEST:"1",
      VLM_PROVIDER:"openai", OPENAI_MODEL:"gpt-6-luna", OPENAI_REASONING_EFFORT:"low", VLM_PERSON_TAGS:"0",
      ROUTING_RECALL_ASSETS_DIR:"/app/data/recall-90-v1", ROUTING_RECALL_ASSETS_URI:uri(profile.recallKey),
      ROUTING_RECALL_ASSETS_SHA256:profile.recallSha256, ROUTING_RECALL_PROP_PYTHON:"/opt/recall-prop/bin/python"});
  } else if (role === "converter") {
    if (!converterImage) throw new Error("Converter runtime image required");
    add({CONVERTER_INTERACTIVE_ENABLED:"true", CONVERTER_INTERACTIVE_ROOT:"/tmp/standin-interactive-private",
      CONVERTER_MAX_CONCURRENT_PROCESSES:"2", CSP_SHAPE_ENABLED:"true", POSE_PREVIEW_URI:uri(profile.previewPrefix),
      REVIEWED_LIBRARY_ROOT:"/app/reviewed-library", REVIEWED_LIBRARY_SHA256:profile.reviewedManifestSha256});
    main.addSecret("CONVERTER_INTERACTIVE_TOKEN",ecs.Secret.fromSecretsManager(token));
    task.addVolume({name:"reviewed-library"});
    main.addMountPoints({sourceVolume:"reviewed-library",containerPath:"/app/reviewed-library",readOnly:true});
    const init=task.addContainer("reviewed-library-init",{image:converterImage,essential:false,user:"0",
      entryPoint:[],command:["python","-c",readFileSync(path.join(__dirname,"../scripts/install-reviewed-library.py"),"utf8")],
      logging:ecs.LogDrivers.awsLogs({streamPrefix:"reviewed-library-init"}),memoryReservationMiB:128,
      environment:{AWS_REGION:Stack.of(task).region, REVIEWED_LIBRARY_ROOT:"/app/reviewed-library",
        REVIEWED_LIBRARY_ARCHIVE_URI:uri(profile.reviewedKey),REVIEWED_LIBRARY_ARCHIVE_SHA256:profile.reviewedArchiveSha256,
        REVIEWED_LIBRARY_SHA256:profile.reviewedManifestSha256}});
    init.addMountPoints({sourceVolume:"reviewed-library",containerPath:"/app/reviewed-library",readOnly:false});
    main.addContainerDependencies({container:init,condition:ecs.ContainerDependencyCondition.SUCCESS});
    main.addEnvironment("CONVERTER_INTERACTIVE_ENABLED","true");
  } else {
    const access = profile.accessPolicy;
    if (access?.enabled !== true || access.supporterEnabled !== true ||
        !Number.isFinite(Date.parse(access.openBetaEndedAt)) ||
        !Array.isArray(access.operatorInstallationIds) ||
        access.operatorInstallationIds.length !== 3 ||
        new Set(access.operatorInstallationIds).size !== 3 ||
        !access.operatorInstallationIds.every((id: unknown) => typeof id === "string" && /^inst_[a-f0-9-]{36}$/.test(id)))
      throw new Error("production requires the explicit three-operator access policy");
    add({CONVERTER_CHARACTER_ID:"male-base-v0-8-0",BODY_RECOMMENDATION_ENABLED:"false",
      ACCESS_GATE_ENABLED:"true", SUPPORTER_ACCESS_ENABLED:"true",
      ACCESS_OPERATOR_INSTALLATIONS:access.operatorInstallationIds.join(","), OPEN_BETA_ENDED_AT:access.openBetaEndedAt,
      REPLAY_ENABLED:"true",CAPTURE_REPLAY_ENABLED:"true",CSP_RESULT_CAPTURE_ENABLED:"true",
      REPLAY_ENVIRONMENT:"production",REPLAY_CONSENT_MODE:"explicit",REPLAY_BUCKET:replay.bucketName});
    replay.grantReadWrite(task.taskRole,"replays/*");
    if (role === "bff") {
      add({INTERACTIVE_STATE_ENABLED:"true",CSP_SHAPE_ENABLED:"true"});
      main.addSecret("CONVERTER_INTERACTIVE_TOKEN",ecs.Secret.fromSecretsManager(token));
    }
  }
}
