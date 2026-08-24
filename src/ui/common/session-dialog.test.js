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
});
