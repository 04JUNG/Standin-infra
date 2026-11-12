/** Operator-owned release metadata; never include secret values in this file. */
export interface SceneWorkerRelease {
  releaseId: string;
  manifestSha256: string;
  bundleKey: string;
  bundleSha256: string;
  imageTag: string;
  vlmModel: string;
}

export function validateSceneWorkerRelease(value: unknown): SceneWorkerRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scene worker release must be an object");
  }
  const release = value as Record<string, unknown>;
  const names = ["releaseId", "manifestSha256", "bundleKey", "bundleSha256", "imageTag", "vlmModel"];
  if (Object.keys(release).some(name => !names.includes(name)) ||
      names.some(name => typeof release[name] !== "string")) {
    throw new Error("scene worker release has missing or unexpected fields");
  }
  const result = release as unknown as SceneWorkerRelease;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(result.releaseId)) {
    throw new Error("scene worker releaseId is invalid");
  }
  for (const key of ["manifestSha256", "bundleSha256"] as const) {
    if (!/^[a-f0-9]{64}$/.test(result[key]) || /^0+$/.test(result[key])) {
      throw new Error(`scene worker ${key} must pin an actual release`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(result.imageTag)) {
    throw new Error("scene worker imageTag must be a full server commit SHA");
  }
  if (!/^scene-releases\/[A-Za-z0-9_./-]+\.tar\.gz$/.test(result.bundleKey) ||
      result.bundleKey.split("/").some(part => part === ".." || part === "." || !part)) {
    throw new Error("scene worker bundleKey must be inside scene-releases/");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(result.vlmModel)) {
    throw new Error("scene worker requires an explicit Gemini model ID");
  }
  return result;
}
