export interface WappScopeLineage {
  scopeId: string;
  l1Id: string | null;
  l2Id: string | null;
  l3Id: string | null;
  l4Id: string | null;
  l5Id: string | null;
}

export type WappRecordState = "active" | "archived" | "deleted";
export type WappStatus = "active" | "archived";
export type WappAppKeyMode = "generate" | "import";

export interface WappTowerBinding {
  id: string;
  label: string;
  towerUrl: string;
  workspaceId: string | null;
  workspaceOwnerNpub: string;
  userAlias: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WappScheduleWindow {
  days?: number[];
  startTime: string;
  endTime: string;
}

export interface WappSchedule {
  timezone?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  windows?: WappScheduleWindow[];
}

export interface WappRecord {
  id: string;
  wappInstallationId: string;
  appId: string;
  title: string;
  description: string | null;
  ownerNpub: string;
  createdByNpub: string;
  workspaceOwnerNpub: string;
  scopeId: string;
  scopeLineage: WappScopeLineage;
  allowedNpubs: string[];
  launchUrl: string;
  sourceWingmanUrl: string | null;
  subdomainAlias: string | null;
  towerBindingId: string | null;
  towerBinding: WappTowerBinding | null;
  appNpub: string | null;
  publisherNpub: string | null;
  pendingPublisherNpub: string | null;
  registeredOpenOrigins: string[];
  status: WappStatus;
  schedule: WappSchedule | null;
  recordState: WappRecordState;
  createdAt: string;
  updatedAt: string;
  lastPublishedAt: string | null;
}

export interface CreateWappInput {
  id?: string;
  appId: string;
  title: string;
  description?: string | null;
  ownerNpub: string;
  createdByNpub: string;
  workspaceOwnerNpub: string;
  scopeId: string;
  scopeLineage?: Partial<WappScopeLineage> | null;
  allowedNpubs: string[];
  launchUrl: string;
  sourceWingmanUrl?: string | null;
  subdomainAlias?: string | null;
  towerBindingId?: string | null;
  appKeyMode?: WappAppKeyMode;
  appNsec?: string | null;
  registeredOpenOrigins?: string[];
  status?: WappStatus;
  schedule?: WappSchedule | null;
}

export interface UpdateWappInput {
  title?: string;
  description?: string | null;
  workspaceOwnerNpub?: string;
  scopeId?: string;
  scopeLineage?: Partial<WappScopeLineage> | null;
  allowedNpubs?: string[];
  launchUrl?: string;
  sourceWingmanUrl?: string | null;
  subdomainAlias?: string | null;
  towerBindingId?: string | null;
  appKeyMode?: WappAppKeyMode;
  appNsec?: string | null;
  registeredOpenOrigins?: string[];
  status?: WappStatus;
  schedule?: WappSchedule | null;
  recordState?: WappRecordState;
  lastPublishedAt?: string | null;
}

export interface CreateWappTowerBindingInput {
  id?: string;
  label: string;
  towerUrl: string;
  workspaceId?: string | null;
  workspaceOwnerNpub: string;
  userAlias?: string | null;
  isDefault?: boolean;
}

export interface UpdateWappTowerBindingInput {
  label?: string;
  towerUrl?: string;
  workspaceId?: string | null;
  workspaceOwnerNpub?: string;
  userAlias?: string | null;
  isDefault?: boolean;
}
