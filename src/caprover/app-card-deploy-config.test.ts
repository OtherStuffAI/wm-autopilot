import { describe, expect, test } from 'bun:test';

import {
  AppCardCaproverDeployConfigError,
  readAppCardCaproverDeployConfig,
} from './app-card-deploy-config';

describe('app-card CapRover deploy config', () => {
  test('accepts bounded runtime and persistent-volume configuration', () => {
    expect(readAppCardCaproverDeployConfig({
      hasPersistentData: true,
      instanceCount: 1,
      containerHttpPort: 80,
      envVars: [{ key: 'KINDLING_API_URL', value: 'https://api.example.com' }],
      volumes: [{ containerPath: '/data', volumeName: 'kindling-fe-data' }],
    })).toEqual({
      hasPersistentData: true,
      instanceCount: 1,
      containerHttpPort: 80,
      envVars: [{ key: 'KINDLING_API_URL', value: 'https://api.example.com' }],
      volumes: [{ containerPath: '/data', volumeName: 'kindling-fe-data' }],
    });
  });

  test('keeps every runtime setting optional for existing callers', () => {
    expect(readAppCardCaproverDeployConfig({ caproverName: 'kindling-fe' })).toEqual({});
  });

  test.each([
    [{ instanceCount: 0 }, 'instanceCount'],
    [{ containerHttpPort: 70000 }, 'containerHttpPort'],
    [{ envVars: [{ key: 'BAD-KEY', value: 'x' }] }, 'key'],
    [{ envVars: [{ key: 'A', value: 'x' }, { key: 'A', value: 'y' }] }, 'duplicate'],
    [{ volumes: [{ containerPath: 'data', volumeName: 'v' }] }, 'absolute'],
    [{ volumes: [{ containerPath: '/data', volumeName: 'v', hostPath: '/tmp/data' }] }, 'exactly one'],
    [{ hasPersistentData: false, volumes: [{ containerPath: '/data', volumeName: 'v' }] }, 'hasPersistentData'],
    [{ instanceCount: 2, volumes: [{ containerPath: '/data', volumeName: 'v' }] }, 'instanceCount 1'],
  ])('rejects unsafe or inconsistent input %#', (input, expected) => {
    expect(() => readAppCardCaproverDeployConfig(input)).toThrow(AppCardCaproverDeployConfigError);
    expect(() => readAppCardCaproverDeployConfig(input)).toThrow(expected);
  });
});
