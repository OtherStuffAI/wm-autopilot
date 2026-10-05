import { createInput, createCheckbox } from './agent-chat-shared-ui.js';

export function createAgentEnrichmentFields() {
  const element = document.createElement('fieldset');
  element.hidden = true;
  element.dataset.testid = 'agent-enrichment-fields';
  const legend = document.createElement('legend');
  legend.textContent = 'Context enrichment for this workspace';
  const workspace = createInput('Workspace ID', '', 'agent-enrichment-workspace');
  const pipelineRow = document.createElement('label');
  pipelineRow.textContent = 'Versioned enrichment pipeline';
  const pipeline = document.createElement('select');
  pipeline.dataset.testid = 'agent-enrichment-pipeline';
  pipeline.setAttribute('aria-label', 'Versioned enrichment pipeline');
  pipelineRow.append(pipeline);
  const memory = createCheckbox('Recall Tower graph memory (unchecked means None)', 'agent-enrichment-memory', false);
  const owner = createInput('Graph owner npub', '', 'agent-enrichment-owner');
  const source = createInput('Memory source filter (optional)', '', 'agent-enrichment-source');
  const app = createInput('Source app npub filter (empty uses current app)', '', 'agent-enrichment-app');
  const group = createInput('Group filter (optional)', '', 'agent-enrichment-group');
  const label = createInput('Graph label filter (optional)', '', 'agent-enrichment-label');
  const actor = createInput('Graph actor npub filter (optional)', '', 'agent-enrichment-actor');
  const visibility = createInput('Visibility filter (optional)', '', 'agent-enrichment-visibility');
  const recommendations = createCheckbox('Recommend eligible pipelines', 'agent-enrichment-recommend-pipelines', true);
  const tools = createInput('Existing MCP tool names to consider (comma separated, empty means None)', '', 'agent-enrichment-tools');
  const threshold = createInput('Usefulness threshold (0–1)', '0.9', 'agent-enrichment-threshold');
  const budget = createInput('Maximum context characters (256–24000)', '6000', 'agent-enrichment-budget');
  const timeout = createInput('Enrichment timeout in milliseconds (100–60000)', '12000', 'agent-enrichment-timeout');
  const note = document.createElement('p');
  note.textContent = 'Context recommendations use existing permissions and tools. They do not load callable tools or start work. The current workspace owner is always enforced for memory queries.';
  element.append(legend, workspace.row, pipelineRow, memory.row, owner.row, source.row, app.row, group.row,
    label.row, actor.row, visibility.row, recommendations.row, tools.row, threshold.row, budget.row, timeout.row, note);
  let configs = {};
  function loadWorkspace() {
    const config = configs[workspace.input.value];
    pipeline.value = config ? `${config.pipeline}@${config.version}` : pipeline.options?.[0]?.value || '';
    memory.input.checked = Boolean(config?.memory);
    owner.input.value = config?.memory?.ownerNpub || '';
    for (const [field, key] of [[source, 'source'], [app, 'sourceAppNpub'], [group, 'groupId'], [label, 'label'], [actor, 'actorNpub'], [visibility, 'visibility']]) field.input.value = config?.memory?.[key] || '';
    recommendations.input.checked = config?.recommendPipelines !== false;
    tools.input.value = (config?.toolNames || []).join(', ');
    threshold.input.value = String(config?.threshold ?? .9);
    budget.input.value = String(config?.maxContextChars ?? 6000);
    timeout.input.value = String(config?.timeoutMs ?? 12000);
  }
  workspace.input.addEventListener('change', loadWorkspace);
  return {
    element,
    setOptions(options) {
      pipeline.replaceChildren();
      for (const definition of options.pipelines || []) {
        const option = document.createElement('option');
        option.value = `${definition.name}@${definition.version}`;
        option.textContent = `${definition.name} · v${definition.version}`;
        pipeline.append(option);
      }
    },
    open(agent) {
      configs = structuredClone(agent.directChat?.enrichmentByWorkspace || {});
      workspace.input.value = Object.keys(configs)[0] || agent.workspaceId || '';
      loadWorkspace();
    },
    payload(mode) {
      if (mode !== 'pipeline_enrichment') return configs;
      const workspaceId = workspace.input.value.trim();
      const split = pipeline.value.lastIndexOf('@');
      if (!workspaceId || split < 1) throw new Error('Enter a workspace and select a versioned enrichment pipeline.');
      if (memory.input.checked && !owner.input.value.trim()) throw new Error('Enter the graph owner or choose None.');
      return { ...configs, [workspaceId]: {
        pipeline: pipeline.value.slice(0, split), version: pipeline.value.slice(split + 1),
        memory: memory.input.checked ? { ownerNpub: owner.input.value.trim(), source: source.input.value.trim(),
          sourceAppNpub: app.input.value.trim() || undefined, groupId: group.input.value.trim(), label: label.input.value.trim(),
          actorNpub: actor.input.value.trim(), visibility: visibility.input.value.trim() } : null,
        recommendPipelines: recommendations.input.checked, toolNames: tools.input.value.split(',').map(s => s.trim()).filter(Boolean),
        threshold: Number(threshold.input.value), maxContextChars: Number(budget.input.value), timeoutMs: Number(timeout.input.value),
      } };
    },
  };
}
