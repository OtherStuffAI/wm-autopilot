import { describe, expect, test } from 'bun:test';

import { createSessionDialogController, getModelOptionsForAgent } from './session-dialog.js';

describe('session dialog model options', () => {
  test('renders the configured ordered modelOptions for the selected agent', () => {
    const config = {
      agents: [
        {
          id: 'goose',
          modelOptions: ['default', 'qwen/qwen3.7-flash', 'anthropic/claude-opus-5-fast'],
        },
      ],
    };

    expect(getModelOptionsForAgent(config, 'goose')).toEqual([
      'default',
      'qwen/qwen3.7-flash',
      'anthropic/claude-opus-5-fast',
    ]);
  });

  test('does not invent model options when config is unavailable', () => {
    expect(getModelOptionsForAgent(null, 'pi')).toEqual([]);
  });

  test('shows all Maple Desktop models with the Desktop-owned default first', () => {
    expect(getModelOptionsForAgent({
      agents: [{
        id: 'maple',
        label: 'Maple Desktop',
        modelOptions: [
          'DeepSeek V4 Flash',
          'OpenAI GPT-OSS 120B',
          'Gemma 4 31B',
          'Kimi K3',
          'Kimi K2.6',
          'GLM 5.2',
          'Llama 3.3 70B',
        ],
      }],
    }, 'maple')).toEqual([
      'DeepSeek V4 Flash',
      'OpenAI GPT-OSS 120B',
      'Gemma 4 31B',
      'Kimi K3',
      'Kimi K2.6',
      'GLM 5.2',
      'Llama 3.3 70B',
    ]);
  });

  test('adds an explicit ACP permission override to session metadata', () => {
    const controller = createSessionDialogController({
      agentSelect: { value: 'goose', addEventListener: () => {} },
      directoryInput: { value: '/tmp/project', addEventListener: () => {} },
      directoryFavoritesSelect: { value: '', addEventListener: () => {} },
      modelSelect: { value: '' },
      sessionNameInput: { value: 'Policy test' },
      acpPermissionPolicySelect: { value: 'ask' },
      onSubmit: () => {},
      isAuthenticated: () => true,
      getConfig: () => null,
      getFallbackDirectory: () => '/tmp/project',
    });

    expect(controller.collectValues().metadata).toEqual({ acpPermissionPolicy: 'ask' });
  });

  test('pins Codex SDK for one launch and ignores the choice for other agents', () => {
    const agentSelect = { value: 'codex', addEventListener: () => {} };
    const transportSelect = { value: 'codex-sdk' };
    const controller = createSessionDialogController({
      agentSelect,
      codexTransportSelect: transportSelect,
      directoryInput: { value: '/tmp/project', addEventListener: () => {} },
      directoryFavoritesSelect: { value: '', addEventListener: () => {} },
      modelSelect: { value: '' },
      sessionNameInput: { value: 'Transport test' },
      onSubmit: () => {},
      isAuthenticated: () => true,
      getConfig: () => null,
      getFallbackDirectory: () => '/tmp/project',
    });
    expect(controller.collectValues().metadata).toEqual({ agentTransport: 'codex-sdk' });
    agentSelect.value = 'claude';
    expect(controller.collectValues().metadata).toBeNull();
    agentSelect.value = 'codex';
    transportSelect.value = 'agentapi';
    expect(controller.collectValues().metadata).toEqual({ agentTransport: 'agentapi' });
    transportSelect.value = '';
    expect(controller.collectValues().metadata).toBeNull();
  });
});

test('DeepSeek selector uses the API catalogue and keeps provider default coherent', () => {
  expect(getModelOptionsForAgent({ agents: [{ id: 'deepseek', label: 'DeepSeek Harness', modelOptions: ['default'] }] }, 'deepseek')).toEqual(['default']);
  const controller = createSessionDialogController({
    agentSelect: { value: 'deepseek', addEventListener: () => {} },
    directoryInput: { value: '/tmp/project', addEventListener: () => {} },
    directoryFavoritesSelect: { value: '', addEventListener: () => {} },
    modelSelect: { value: 'default' }, sessionNameInput: { value: 'Harness' },
    acpPermissionPolicySelect: { value: 'ask' }, onSubmit: () => {},
    isAuthenticated: () => true, getConfig: () => null, getFallbackDirectory: () => '/tmp/project',
  });
  expect(controller.collectValues()).toMatchObject({ agentId: 'deepseek', metadata: { acpPermissionPolicy: 'ask' } });
});
