export type SkillSourceClass = "wingman" | "third_party" | "user";
export type SkillSourceKind = "git" | "local";
export type SkillDeploymentState =
  | "current"
  | "update_available"
  | "locally_modified"
  | "conflict"
  | "missing"
  | "error";

export interface SkillSourceRecord {
  id: string;
  ownerNpub: string;
  name: string;
  sourceClass: SkillSourceClass;
  sourceKind: SkillSourceKind;
  location: string;
  ref: string | null;
  fetchedCommit: string | null;
  fetchedDigest: string | null;
  fetchedAt: string | null;
  activeImportId: string | null;
  trustState: "system" | "operator_imported" | "user_imported";
  defaultEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRevisionRecord {
  id: string;
  importId: string;
  sourceId: string;
  skillId: string;
  name: string;
  description: string;
  relativePath: string;
  sourceCommit: string | null;
  contentDigest: string;
  compatibility: string[];
  files: string[];
  executableFiles: string[];
  warnings: string[];
  errors: string[];
  snapshotPath: string;
  importedAt: string;
  activatedAt: string | null;
}

export interface SkillDeploymentRecord {
  id: string;
  ownerNpub: string;
  projectId: string;
  targetDirectory: string;
  skillId: string;
  revisionId: string;
  deploymentName: string;
  installedDigest: string;
  portable: boolean;
  claudeCompatibility: boolean;
  repositoryPolicy: "local_managed" | "repository_shared";
  state: SkillDeploymentState;
  installedAt: string;
  updatedAt: string;
  checkedAt: string;
  lastResult: string | null;
}

export interface SkillProjectPolicy {
  ownerNpub: string;
  projectId: string;
  claudeCompatibility: boolean;
  repositoryPolicy: "local_managed" | "repository_shared";
  defaultOptOuts: string[];
  updatedAt: string;
}

export interface SkillPlanOperation {
  action: "apply" | "update" | "remove" | "detach" | "reconcile";
  projectId: string;
  targetDirectory: string;
  skillId: string;
  revisionId: string | null;
  deploymentName: string;
  claudeCompatibility: boolean;
  repositoryPolicy: "local_managed" | "repository_shared";
  resolution: "safe" | "replace" | "detach" | null;
  state: SkillDeploymentState;
  reason: string;
}
