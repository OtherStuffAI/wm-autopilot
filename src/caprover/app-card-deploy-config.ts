import type { CaproverEnvVar, CaproverVolume } from './types';

export interface AppCardCaproverDeployConfig {
  hasPersistentData?: boolean;
  instanceCount?: number;
  containerHttpPort?: number;
  envVars?: CaproverEnvVar[];
  volumes?: CaproverVolume[];
}

export class AppCardCaproverDeployConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppCardCaproverDeployConfigError';
  }
}

function integerInRange(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppCardCaproverDeployConfigError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safeAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new AppCardCaproverDeployConfigError(`${field} must be an absolute path`);
  }
  const segments = value.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    throw new AppCardCaproverDeployConfigError(`${field} must not contain traversal segments`);
  }
  return value;
}

function readEnvVars(value: unknown): CaproverEnvVar[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new AppCardCaproverDeployConfigError('envVars must be an array with at most 128 entries');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppCardCaproverDeployConfigError(`envVars[${index}] must contain key and value`);
    }
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new AppCardCaproverDeployConfigError(`envVars[${index}].key is invalid`);
    }
    if (seen.has(key)) throw new AppCardCaproverDeployConfigError(`envVars contains duplicate key ${key}`);
    seen.add(key);
    if (typeof record.value !== 'string') {
      throw new AppCardCaproverDeployConfigError(`envVars[${index}].value must be a string`);
    }
    return { key, value: record.value };
  });
}

function readVolumes(value: unknown): CaproverVolume[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw new AppCardCaproverDeployConfigError('volumes must be an array with at most 32 entries');
  }
  const containerPaths = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppCardCaproverDeployConfigError(`volumes[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const containerPath = safeAbsolutePath(record.containerPath, `volumes[${index}].containerPath`);
    if (containerPaths.has(containerPath)) {
      throw new AppCardCaproverDeployConfigError(`volumes contains duplicate container path ${containerPath}`);
    }
    containerPaths.add(containerPath);
    const hostPath = record.hostPath === undefined
      ? undefined
      : safeAbsolutePath(record.hostPath, `volumes[${index}].hostPath`);
    const volumeName = typeof record.volumeName === 'string' ? record.volumeName.trim() : undefined;
    if (volumeName && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(volumeName)) {
      throw new AppCardCaproverDeployConfigError(`volumes[${index}].volumeName is invalid`);
    }
    if (Boolean(hostPath) === Boolean(volumeName)) {
      throw new AppCardCaproverDeployConfigError(`volumes[${index}] requires exactly one of hostPath or volumeName`);
    }
    return { containerPath, ...(hostPath ? { hostPath } : { volumeName }) };
  });
}

export function readAppCardCaproverDeployConfig(record: Record<string, unknown>): AppCardCaproverDeployConfig {
  if (record.hasPersistentData !== undefined && typeof record.hasPersistentData !== 'boolean') {
    throw new AppCardCaproverDeployConfigError('hasPersistentData must be a boolean');
  }
  const instanceCount = integerInRange(record.instanceCount, 'instanceCount', 1, 64);
  const containerHttpPort = integerInRange(record.containerHttpPort, 'containerHttpPort', 1, 65535);
  const envVars = readEnvVars(record.envVars);
  const volumes = readVolumes(record.volumes);
  if (volumes?.length && record.hasPersistentData === false) {
    throw new AppCardCaproverDeployConfigError('volumes require hasPersistentData to be true or omitted');
  }
  if (volumes?.length && instanceCount !== undefined && instanceCount !== 1) {
    throw new AppCardCaproverDeployConfigError('persistent volumes require instanceCount 1');
  }
  return {
    ...(record.hasPersistentData === undefined ? {} : { hasPersistentData: record.hasPersistentData }),
    ...(instanceCount === undefined ? {} : { instanceCount }),
    ...(containerHttpPort === undefined ? {} : { containerHttpPort }),
    ...(envVars === undefined ? {} : { envVars }),
    ...(volumes === undefined ? {} : { volumes }),
  };
}
