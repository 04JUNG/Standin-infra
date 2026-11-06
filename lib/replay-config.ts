/** Replay deployment classification is independent of Node's production optimizations. */
export interface ReplayDeploymentConfig {
  enabled: boolean;
  captureEnabled: boolean;
  cspEnabled: boolean;
  consentMode: "assumed" | "explicit";
}
export function replayConfig(
  envName: "prod" | "staging",
  context: (name: string) => unknown,
): ReplayDeploymentConfig {
  const prefix = envName === "staging" ? "stagingReplay" : "productionReplay";
  function flag(suffix: string, fallback: boolean): boolean {
    const value = context(prefix + suffix);
    if (value === undefined) return fallback;
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw new Error(`${prefix}${suffix} must be true or false`);
  }
  const consentMode = context(prefix + "ConsentMode") ?? (envName === "staging" ? "assumed" : "explicit");
  if (consentMode !== "assumed" && consentMode !== "explicit") {
    throw new Error(`${prefix}ConsentMode must be assumed or explicit`);
  }
  if (envName === "prod" && consentMode !== "explicit") {
    throw new Error("Production replay requires explicit consent");
  }
  return {
    enabled: flag("Enabled", envName === "staging"),
    captureEnabled: flag("CaptureEnabled", true),
    cspEnabled: flag("CspEnabled", true),
    consentMode,
  };
}
