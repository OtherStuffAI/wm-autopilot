import { generateIdentityAlias } from '../../identity/identity-alias';
import type { FunctionRegistry } from '../../pipelines/declarative';
import { loadPipelineFunctionRegistry } from '../../pipelines/function-loader';
import { builtinPipelineFunctions } from '../../pipelines/functions';
import { getPipelineDefinition, listLatestPipelineDefinitions, type PipelineDefinitionRecord } from '../../pipelines/pipeline-loader';
import { runDeclarativePipeline, startDeclarativePipeline } from '../../pipelines/pipeline-runner';
import { type JsonObject, PipelineStore, type PipelineRunRecord } from '../../pipelines/pipeline-store';
import type { SessionApiContext } from '../../server/session-api-routes';
import { agentDefinitionStore, type AgentDefinitionStore } from '../agent-definition-store';
import type {
  AgentCapability,
  AgentChatDispatchHistoryEntry,
  AgentDefinitionRecord,
  DispatchRouteRecord,
  DispatchTriggerKind,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from '../types';
import type {
  AgentWorkspacePolicyAction,
  AgentWorkspaceEventType,
  ResolvedAppendedContext,
  ResolvedPipelineSelection,
} from '../agent-profile-policy-store';
import { fetchFlightDeckPgScopeChannels, type FlightDeckPgChannel, type FlightDeckPgWorkroomContext } from '../tower-client';
import {
  DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
  normaliseBuiltInDispatchPipelineId,
  stableDispatchPipelineIdForRoute,
  type DispatchPipelineVersionPolicy,
} from './pipeline-policy';
import {
  createDispatchFlightDeckPublisher,
  createDispatchChatContextHydrator,
  createDispatchChatThreadReloader,
  createDispatchDiscussionDocumentEnsurer,
  createDispatchChatTaskCreator,
  createDispatchCreatedTaskBlocker,
  createDispatchImplementationReviewProgressCommenter,
  createDispatchImplementationReviewTaskEnsurer,
  createDispatchDocumentInvocationContextPreparer,
  createDispatchDocumentInvocationSummaryPublisher,
  createDispatchTaskInvocationContextPreparer,
  createDispatchTaskInvocationResponsePublisher,
  createDispatchNeedsInputPublisher,
  createDispatchResponseActivityPublisher,
  createDispatchReviewTaskCompleter,
  createDispatchTaskStateUpdater,
  acknowledgeChatDispatchMessage,
  pipelineNeedsFlightDeckPublisher,
  prepareDispatchPipelineFlightDeckRuntime,
  type DispatchPipelineFlightDeckRuntime,
} from './flightdeck-publisher';
import { dispatchRouteStore, type DispatchRouteStore } from './route-store';
import { sourceLabelForDispatchInput } from '../flightdeck-dispatch-metadata';
import type { DuplicateCallbackPublicationFilter } from '../duplicate-callback-publication-filter';

export interface DispatchPipelineEventInput {
  subscription: WorkspaceSubscriptionRecord;
  triggerKind: DispatchTriggerKind;
  capability: AgentCapability;
  recordId: string;
  record: Record<string, unknown>;
  payload: Record<string, unknown>;
  recordFamily: string;
  recordState: string | null;
  recordVersion: number | null;
  updaterNpub: string | null;
  bindingType: AgentChatDispatchHistoryEntry['bindingType'];
  bindingId: string | null;
  scopeId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  changedFields?: string[];
  groupNpubs?: string[];
  botIdentity?: RuntimeBotIdentity | null;
  profileRuntime?: DispatchProfileRuntimeContext | null;
  workroomContext?: FlightDeckPgWorkroomContext | null;
  sourceLabel?: string | null;
}

export interface DispatchProfileRuntimeContext {
  profileWorkspaceId: string;
  eventType: AgentWorkspaceEventType;
  enabled: boolean;
  defaultAction: AgentWorkspacePolicyAction;
  quietMode: boolean;
  pipeline: ResolvedPipelineSelection;
  appendedContext: ResolvedAppendedContext[];
}

export interface DispatchFlightDeckChannelContext {
  id: string;
  scopeId: string;
  name: string | null;
  contextPrompt: string;
  hasSpecificContext: boolean;
}

export interface DispatchPipelineRuntimeResult {
  handled: boolean;
  historyEntries: AgentChatDispatchHistoryEntry[];
  lastPipelineRunId: string | null;
}

export interface DispatchChatAcknowledgementInput {
  eventInput: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
  flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
}

export interface DispatchPipelineRuntimeDependencies {
  routeStore?: DispatchRouteStore;
  agentStore?: AgentDefinitionStore;
  pipelineStore: PipelineStore;
  getSessionApiContext: () => SessionApiContext | null;
  getBotIdentityForSubscription?: (subscriptionId: string) => RuntimeBotIdentity | null;
  callbackOrigin: string;
  runPipeline?: typeof runDeclarativePipeline;
  startPipeline?: typeof startDeclarativePipeline;
  loadDefinition?: typeof getPipelineDefinition;
  listDefinitions?: typeof listLatestPipelineDefinitions;
  loadFunctions?: typeof loadPipelineFunctionRegistry;
  acknowledgeChatMessage?: (input: DispatchChatAcknowledgementInput) => Promise<JsonObject>;
  resolveFlightDeckChannelContext?: (input: DispatchPipelineEventInput) => Promise<DispatchFlightDeckChannelContext | null>;
  requirePipelineRoutes?: boolean;
  defaultAgent?: string;
  publicationFilter?: DuplicateCallbackPublicationFilter;
}

export class DispatchPipelineRuntime {
  private readonly routeStore: DispatchRouteStore;
  private readonly agentStore: AgentDefinitionStore;
  private readonly pipelineStore: PipelineStore;
  private readonly getSessionApiContext: () => SessionApiContext | null;
  private readonly getBotIdentityForSubscription: (subscriptionId: string) => RuntimeBotIdentity | null;
  private readonly callbackOrigin: string;
  private readonly runPipeline: typeof runDeclarativePipeline | null;
  private readonly startPipeline: typeof startDeclarativePipeline;
  private readonly loadDefinition: typeof getPipelineDefinition;
  private readonly listDefinitions: typeof listLatestPipelineDefinitions;
  private readonly loadFunctions: typeof loadPipelineFunctionRegistry;
  private readonly acknowledgeChatMessage: (input: DispatchChatAcknowledgementInput) => Promise<JsonObject>;
  private readonly resolveFlightDeckChannelContext: (input: DispatchPipelineEventInput) => Promise<DispatchFlightDeckChannelContext | null>;
  private readonly requirePipelineRoutes: boolean;
  private readonly defaultAgent: string;
  private readonly publicationFilter: DuplicateCallbackPublicationFilter | undefined;
  private readonly pendingDispatchDedupeKeys = new Set<string>();

  constructor(deps: DispatchPipelineRuntimeDependencies) {
    this.routeStore = deps.routeStore ?? dispatchRouteStore;
    this.agentStore = deps.agentStore ?? agentDefinitionStore;
    this.pipelineStore = deps.pipelineStore;
    this.getSessionApiContext = deps.getSessionApiContext;
    this.getBotIdentityForSubscription = deps.getBotIdentityForSubscription ?? (() => null);
    this.callbackOrigin = deps.callbackOrigin;
    this.runPipeline = deps.runPipeline ?? null;
    this.startPipeline = deps.startPipeline ?? startDeclarativePipeline;
    this.loadDefinition = deps.loadDefinition ?? getPipelineDefinition;
    this.listDefinitions = deps.listDefinitions ?? listLatestPipelineDefinitions;
    this.loadFunctions = deps.loadFunctions ?? loadPipelineFunctionRegistry;
    this.acknowledgeChatMessage = deps.acknowledgeChatMessage ?? acknowledgeChatPipelineMessage;
    this.resolveFlightDeckChannelContext = deps.resolveFlightDeckChannelContext ?? resolveFlightDeckChannelContextFromTower;
    this.requirePipelineRoutes = deps.requirePipelineRoutes ?? false;
    this.defaultAgent = normaliseDefaultAgent(deps.defaultAgent);
    this.publicationFilter = deps.publicationFilter;
  }

  listRoutesForManager(managedByNpub: string): DispatchRouteRecord[] {
    return this.routeStore.listForManager(managedByNpub);
  }

  listRoutesForSubscription(subscriptionId: string): DispatchRouteRecord[] {
    return this.routeStore.listForSubscription(subscriptionId);
  }

  saveRoute(input: Parameters<DispatchRouteStore['save']>[0]): DispatchRouteRecord {
    return this.routeStore.save(input);
  }

  deleteRouteForManager(routeId: string, managedByNpub: string): boolean {
    return this.routeStore.deleteForManager(routeId, managedByNpub);
  }

  deleteRoutesForSubscriptionForManager(subscriptionId: string, managedByNpub: string): number {
    return this.routeStore.deleteForSubscriptionForManager(subscriptionId, managedByNpub);
  }

  async dispatch(input: DispatchPipelineEventInput): Promise<DispatchPipelineRuntimeResult> {
    const storedRoutes = this.routeStore.listForSubscriptionTrigger({
      subscriptionId: input.subscription.subscriptionId,
      triggerKind: input.triggerKind,
      capability: input.capability,
    });
    const configuredRoutes = [
      ...buildProfilePolicyRoutes(input, storedRoutes.length),
      ...storedRoutes,
    ];
    if (configuredRoutes.length === 0) {
      if (this.requirePipelineRoutes) {
        return {
          handled: true,
          historyEntries: [this.buildMissingRouteHistoryEntry(input)],
          lastPipelineRunId: null,
        };
      }
      return { handled: false, historyEntries: [], lastPipelineRunId: null };
    }

    const disabledRoutes = configuredRoutes.filter((route) => !route.enabled);
    const enabledMatches = configuredRoutes
      .filter((route) => route.enabled)
      .filter((route) => routeMatchesEvent(route, input));

    if (enabledMatches.length === 0) {
      const route = disabledRoutes[0] ?? configuredRoutes[0]!;
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_suppressed`,
            status: 'suppressed',
            pipelineRunId: null,
            suppressionReason: disabledRoutes.length > 0 ? 'route_disabled' : 'route_match_failed',
            diagnosticSummary: disabledRoutes.length > 0
              ? 'Dispatch route is disabled.'
              : 'No enabled dispatch route matched the advisory.',
          }),
        ],
        lastPipelineRunId: null,
      };
    }

    const route = enabledMatches[0]!;
    const agent = this.selectAgent(input);
    if (isSelfAuthoredChatEvent(input, agent)) {
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_suppressed`,
            status: 'suppressed',
            pipelineRunId: null,
            suppressionReason: 'self_authored',
            diagnosticSummary: 'Chat dispatch suppressed because the advisory message was authored by this Wingman.',
          }),
        ],
        lastPipelineRunId: null,
      };
    }

    const dedupeKey = buildDedupeKey(input, route);
    const concurrencyKey = renderTemplate(route.concurrencyKeyTemplate, {
      route,
      workspace: input.subscription,
      record: input,
      routing: input,
    }) || dedupeKey;
    const pendingDedupeKey = `${route.routeId}:${dedupeKey}`;
    if (this.pendingDispatchDedupeKeys.has(pendingDedupeKey)) {
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_suppressed`,
            status: 'suppressed',
            pipelineRunId: null,
            concurrencyKey,
            dedupeKey,
            dedupeReason: 'in_flight_duplicate',
            suppressionReason: 'dedupe_in_flight',
            diagnosticSummary: 'Dispatch route is already starting a pipeline for this advisory.',
          }),
        ],
        lastPipelineRunId: null,
      };
    }
    const suppressedRun = this.findSuppressedDispatchRun(route, dedupeKey, concurrencyKey);
    if (suppressedRun) {
      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_suppressed`,
            status: 'suppressed',
            pipelineRunId: suppressedRun.run.id,
            concurrencyKey,
            dedupeKey,
            dedupeReason: suppressedRun.dedupeReason,
            suppressionReason: suppressedRun.suppressionReason,
            diagnosticSummary: suppressedRun.diagnosticSummary,
          }),
        ],
        lastPipelineRunId: suppressedRun.run.id,
      };
    }

    this.pendingDispatchDedupeKeys.add(pendingDedupeKey);
    try {
      let flightDeckRuntime = emptyFlightDeckRuntime();
      let chatAcknowledgement: JsonObject | null = null;
      if (input.triggerKind === 'chat') {
        flightDeckRuntime = await prepareDispatchPipelineFlightDeckRuntime({ eventInput: input, agent });
        try {
          chatAcknowledgement = await this.acknowledgeChatMessage({
            eventInput: input,
            agent,
            flightDeckRuntime,
          });
        } catch (error) {
          chatAcknowledgement = buildFailedChatAcknowledgement(input, error);
        }
      }

      const ownerNpub = input.subscription.managedByNpub ?? route.managedByNpub;
      const ownerAlias = generateIdentityAlias(ownerNpub);
      const resolvedPipelineDefinitionId = resolveRoutePipelineDefinitionId(route);
      const definition = await this.loadDefinition(resolvedPipelineDefinitionId, ownerAlias)
        ?? await this.loadFallbackDefinitionForRoute(route, ownerAlias);
      const sessionApiContext = this.getSessionApiContext();
      if (!definition || !sessionApiContext) {
        return {
          handled: true,
          historyEntries: [
            this.buildHistoryEntry(input, route, {
              action: `${input.triggerKind}_pipeline_failed`,
              status: 'failed',
              pipelineRunId: null,
              acknowledgement: chatAcknowledgement,
              diagnosticSummary: !definition
                ? `Pipeline definition not found: ${resolvedPipelineDefinitionId}`
                : 'Pipeline session API context is not ready.',
            }),
          ],
          lastPipelineRunId: null,
        };
      }

      if (pipelineNeedsFlightDeckPublisher(definition.spec) && flightDeckRuntime.mode !== 'flightdeck_pg' && input.triggerKind !== 'chat') {
        flightDeckRuntime = await prepareDispatchPipelineFlightDeckRuntime({ eventInput: input, agent });
      }
      let flightDeckChannelContext: DispatchFlightDeckChannelContext | null = null;
      try {
        flightDeckChannelContext = await this.resolveFlightDeckChannelContext(input);
      } catch (error) {
        return {
          handled: true,
          historyEntries: [
            this.buildHistoryEntry(input, route, {
              action: `${input.triggerKind}_pipeline_failed`,
              status: 'failed',
              pipelineRunId: null,
              acknowledgement: chatAcknowledgement,
              diagnosticSummary: `Flight Deck channel context could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
            }),
          ],
          lastPipelineRunId: null,
        };
      }
      const availablePipelines = await this.listDefinitions(ownerAlias).catch(() => []);
      const envelope = buildDispatchEnvelope({
        route,
        input,
        agent,
        dedupeKey,
        concurrencyKey,
        flightDeckRuntime,
        flightDeckChannelContext,
        acknowledgement: chatAcknowledgement,
        defaultAgent: this.defaultAgent,
        availablePipelines,
      });
      const functions = await this.loadRuntimeFunctions({
        ownerAlias,
        ownerNpub,
        sessionApiContext,
        eventInput: input,
        agent,
        flightDeckRuntime,
        definitionNeedsPublisher: pipelineNeedsFlightDeckPublisher(definition.spec),
      });
      const runnerInput = {
        store: this.pipelineStore,
        sessionApiContext,
        definition,
        registry: functions,
        input: envelope,
        ownerNpub,
        ownerAlias,
        callbackOrigin: this.callbackOrigin,
      };
      const run = this.runPipeline
        ? await this.runPipeline(runnerInput)
        : this.startPipeline(runnerInput);
      const needsInputUpdate = run.status === 'needs_input'
        ? await publishNeedsInputForRun(functions, {
            ...envelope,
            workerResult: objectValue(run.result),
            agentResponse: objectValue(run.result),
            pipelineRun: {
              id: run.id,
              definitionId: run.definitionId,
              status: run.status,
            },
          })
        : null;

      return {
        handled: true,
        historyEntries: [
          this.buildHistoryEntry(input, route, {
            action: `${input.triggerKind}_pipeline_dispatch`,
            status: run.status,
            pipelineRunId: run.id,
            concurrencyKey,
            dedupeKey,
            acknowledgement: chatAcknowledgement,
            diagnosticSummary: needsInputUpdate
              ? `Started dispatch pipeline ${resolvedPipelineDefinitionId}; needs-input question published.`
              : `Started dispatch pipeline ${resolvedPipelineDefinitionId}.`,
          }),
        ],
        lastPipelineRunId: run.id,
      };
    } finally {
      this.pendingDispatchDedupeKeys.delete(pendingDedupeKey);
    }
  }

  async loadRegistryForStoredRun(input: {
    run: PipelineRunRecord;
    definition: PipelineDefinitionRecord;
    sessionApiContext: SessionApiContext;
  }): Promise<FunctionRegistry | null> {
    const stored = buildStoredRunDispatchContext(input.run, this.getBotIdentityForSubscription);
    if (!stored) {
      return null;
    }
    return await this.loadRuntimeFunctions({
      ownerAlias: input.run.ownerAlias ?? '',
      ownerNpub: input.run.ownerNpub ?? '',
      sessionApiContext: input.sessionApiContext,
      eventInput: stored.eventInput,
      agent: stored.agent,
      flightDeckRuntime: stored.flightDeckRuntime,
      definitionNeedsPublisher: pipelineNeedsFlightDeckPublisher(input.definition.spec),
    });
  }

  private async loadRuntimeFunctions(input: {
    ownerAlias: string;
    ownerNpub: string;
    sessionApiContext: SessionApiContext;
    eventInput: DispatchPipelineEventInput;
    agent: AgentDefinitionRecord | null;
    flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
    definitionNeedsPublisher: boolean;
  }): Promise<FunctionRegistry> {
    const functions = await this.loadFunctions(input.ownerAlias, builtinPipelineFunctions);
    const registry: FunctionRegistry = { ...functions.registry };
    if (input.definitionNeedsPublisher) {
      registry['dispatch.publishFlightDeckResponse'] = createDispatchFlightDeckPublisher({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
        userSettingsStore: input.sessionApiContext.userSettingsStore,
        publicationFilter: this.publicationFilter,
      });
      registry['dispatch.hydrateChatContext'] = createDispatchChatContextHydrator({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.reloadChatThread'] = createDispatchChatThreadReloader({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.completeReviewTaskFromChat'] = createDispatchReviewTaskCompleter({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.ensureDiscussionDocument'] = createDispatchDiscussionDocumentEnsurer({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.prepareDocumentInvocationContext'] = createDispatchDocumentInvocationContextPreparer({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.publishDocumentInvocationSummary'] = createDispatchDocumentInvocationSummaryPublisher({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.prepareTaskInvocationContext'] = createDispatchTaskInvocationContextPreparer({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.publishTaskInvocationResponse'] = createDispatchTaskInvocationResponsePublisher({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.createChatTask'] = createDispatchChatTaskCreator({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.blockTaskIfPipelineLaunchFailed'] = createDispatchCreatedTaskBlocker({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.publishNeedsInput'] = createDispatchNeedsInputPublisher({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.setResponseActivity'] = createDispatchResponseActivityPublisher({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.markTaskInProgress'] = createDispatchTaskStateUpdater({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      }, 'in_progress');
      registry['dispatch.markTaskReadyForReview'] = createDispatchTaskStateUpdater({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      }, 'review');
      registry['dispatch.ensureImplementationReviewTask'] = createDispatchImplementationReviewTaskEnsurer({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
      registry['dispatch.commentImplementationReviewProgress'] = createDispatchImplementationReviewProgressCommenter({
        eventInput: input.eventInput,
        agent: input.agent,
        botIdentity: input.eventInput.botIdentity ?? null,
        runtime: input.flightDeckRuntime,
      });
    }
    registry['dispatch.startChildPipeline'] = this.createChildPipelineStarter(input);
    registry['dispatch.startChildPipelines'] = this.createChildPipelinesStarter(input);
    return registry;
  }

  private async loadFallbackDefinitionForRoute(
    route: DispatchRouteRecord,
    ownerAlias: string,
  ): Promise<PipelineDefinitionRecord | null> {
    const fallbackId = fallbackPipelineDefinitionId(route);
    return fallbackId ? await this.loadDefinition(fallbackId, ownerAlias) : null;
  }

  private createChildPipelineStarter(input: {
    ownerAlias: string;
    ownerNpub: string;
    sessionApiContext: SessionApiContext;
    eventInput: DispatchPipelineEventInput;
    agent: AgentDefinitionRecord | null;
    flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
  }) {
    return async (payload: JsonObject): Promise<JsonObject> => {
      const workPlan = objectValue(payload.workPlan ?? payload.agentResponse ?? payload);
      const pipelineDefinitionId = getText(payload.pipelineDefinitionId)
        ?? getText(payload.definitionId)
        ?? getText(workPlan.childPipelineDefinitionId)
        ?? getText(workPlan.recommendedPipeline);
      if (!pipelineDefinitionId) {
        return {
          started: false,
          status: 'failed',
          reason: 'No child pipeline definition id was provided.',
        };
      }
      const childDefinition = await this.loadDefinition(pipelineDefinitionId, input.ownerAlias);
      if (!childDefinition) {
        return {
          started: false,
          status: 'failed',
          pipelineDefinitionId,
          reason: `Pipeline definition not found: ${pipelineDefinitionId}`,
        };
      }
      const childFunctions = await this.loadRuntimeFunctions({
        ...input,
        definitionNeedsPublisher: pipelineNeedsFlightDeckPublisher(childDefinition.spec),
      });
      const childInput = objectValue(payload.childInput ?? payload.input);
      try {
        const run = startDeclarativePipeline({
          store: this.pipelineStore,
          sessionApiContext: input.sessionApiContext,
          definition: childDefinition,
          registry: childFunctions,
          input: {
            ...childInput,
            workPlan,
            parentDispatch: {
              routeId: getText(payload.routeId) ?? getText(input.eventInput.recordId),
              triggerKind: input.eventInput.triggerKind,
              recordId: input.eventInput.recordId,
            },
          },
          ownerNpub: input.ownerNpub,
          ownerAlias: input.ownerAlias,
          callbackOrigin: this.callbackOrigin,
        });
        const needsInputUpdate = run.status === 'needs_input'
          ? await publishNeedsInputForRun(childFunctions, {
              ...childInput,
              workPlan,
              createdTask: objectValue(payload.createdTask ?? childInput.createdTask),
              workerResult: objectValue(run.result),
              agentResponse: objectValue(run.result),
              childPipeline: {
                status: run.status,
                pipelineRunId: run.id,
                pipelineDefinitionId: childDefinition.id,
                pipelineName: childDefinition.name,
              },
            })
          : null;
        return {
          started: true,
          status: run.status,
          pipelineRunId: run.id,
          pipelineDefinitionId: childDefinition.id,
          pipelineName: childDefinition.name,
          needsInputUpdate,
        };
      } catch (error) {
        return {
          started: false,
          status: 'failed',
          pipelineDefinitionId: childDefinition.id,
          pipelineName: childDefinition.name,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    };
  }

  private createChildPipelinesStarter(input: {
    ownerAlias: string;
    ownerNpub: string;
    sessionApiContext: SessionApiContext;
    eventInput: DispatchPipelineEventInput;
    agent: AgentDefinitionRecord | null;
    flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
  }) {
    const startOne = this.createChildPipelineStarter(input);
    return async (payload: JsonObject): Promise<JsonObject> => {
      const rawPipelines = Array.isArray(payload.pipelines) ? payload.pipelines : [];
      const childInput = objectValue(payload.childInput ?? payload.input);
      const createdTask = objectValue(payload.createdTask ?? childInput.createdTask);
      const createdTaskItems = Array.isArray(createdTask.items)
        ? createdTask.items.map((item) => objectValue(item))
        : [];
      const seen = new Set<string>();
      const items: JsonObject[] = [];
      for (let index = 0; index < rawPipelines.length; index += 1) {
        const requirement = objectValue(rawPipelines[index]);
        const requirementId = getText(requirement.requirementId ?? requirement.id ?? requirement.name)
          ?? `requirement-${index + 1}`;
        if (seen.has(requirementId)) {
          items.push({
            requirementId,
            started: false,
            status: 'skipped',
            reason: 'Duplicate pipeline requirement id in the same dispatch.',
          });
          continue;
        }
        seen.add(requirementId);
        const workPlan = objectValue(requirement.workPlan ?? requirement.payload ?? requirement);
        const pipelineDefinitionId = getText(
          requirement.pipelineDefinitionId
            ?? requirement.pipeline
            ?? requirement.pipelineId
            ?? workPlan.pipelineDefinitionId
            ?? workPlan.childPipelineDefinitionId,
        );
        const matchingTask = createdTaskItems.find((item) => getText(item.requirementId) === requirementId) ?? null;
        if (matchingTask && getText(matchingTask.status) === 'failed') {
          items.push({
            requirementId,
            started: false,
            status: 'failed',
            pipelineDefinitionId,
            reason: getText(matchingTask.reason) ?? 'Task creation failed for this pipeline requirement.',
            createdTask: matchingTask,
          });
          continue;
        }
        const taskContext = matchingTask ?? createdTask;
        const taskId = getText(taskContext.taskId);
        const taskWorkPlan = objectValue(taskContext.workPlan);
        const selectedWorkPlan = {
          ...workPlan,
          ...taskWorkPlan,
          requirementId,
          ...(taskId && !getText(workPlan.taskId) ? { taskId } : {}),
        };
        const selected = await startOne({
          pipelineDefinitionId,
          workPlan: selectedWorkPlan,
          childInput: {
            ...childInput,
            createdTask: taskContext,
            workPlan: selectedWorkPlan,
          },
          createdTask: taskContext,
        });
        items.push({
          requirementId,
          taskId,
          ...selected,
        });
      }
      const failed = items.filter((item) => item.started === false || getText(item.status) === 'failed' || getText(item.status) === 'error');
      const needsInput = items.filter((item) => getText(item.status) === 'needs_input');
      return {
        started: items.length > 0 && failed.length === 0,
        status: failed.length > 0 ? 'error' : needsInput.length > 0 ? 'needs_input' : items.length > 0 ? 'running' : 'failed',
        total: items.length,
        failed: failed.length,
        needsInput: needsInput.length,
        items,
        reason: items.length === 0 ? 'No pipeline requirements were provided.' : failed.length > 0 ? 'One or more pipeline requirements failed to start.' : null,
      };
    };
  }

  private findSuppressedDispatchRun(
    route: DispatchRouteRecord,
    dedupeKey: string,
    concurrencyKey: string,
  ): {
    run: PipelineRunRecord;
    suppressionReason: string;
    dedupeReason: string;
    diagnosticSummary: string;
  } | null {
    if (route.activePolicy === 'skip') {
      const activeRun = this.pipelineStore
        .listRunningRuns()
        .filter((run) => dispatchRunMatchesRoute(run, route))
        .find((run) => getDispatchRunConcurrencyKey(run) === concurrencyKey);
      if (activeRun) {
        return {
          run: activeRun,
          suppressionReason: 'active_run',
          dedupeReason: 'active_policy_skip',
          diagnosticSummary: `Dispatch route already has an active pipeline run: ${activeRun.id}.`,
        };
      }
    }

    if (route.dedupeWindowSeconds > 0) {
      const cutoffMs = Date.now() - (route.dedupeWindowSeconds * 1000);
      const recentRun = this.pipelineStore
        .listRuns({ limit: 500 })
        .filter((run) => dispatchRunMatchesRoute(run, route))
        .find((run) => (
          getDispatchRunDedupeKey(run) === dedupeKey
          && getRunLastActivityMs(run) >= cutoffMs
        ));
      if (recentRun) {
        return {
          run: recentRun,
          suppressionReason: 'dedupe_window',
          dedupeReason: 'recent_duplicate',
          diagnosticSummary: `Dispatch route already handled this advisory within ${route.dedupeWindowSeconds}s: ${recentRun.id}.`,
        };
      }
    }

    return null;
  }

  private selectAgent(input: DispatchPipelineEventInput): AgentDefinitionRecord | null {
    const managerNpub = input.subscription.managedByNpub;
    const selectedProfileId = input.subscription.agentProfileId?.trim();
    if (selectedProfileId) {
      const selected = this.agentStore.getByAgentId(selectedProfileId);
      if (!selected || selected.managedByNpub !== managerNpub || !selected.enabled) {
        throw new Error(`Selected dispatch agent profile is unavailable: ${selectedProfileId}`);
      }
      if (selected.botNpub !== input.subscription.botNpub) {
        throw new Error(`Selected dispatch agent profile identity does not match subscription: ${selectedProfileId}`);
      }
      return selected;
    }

    const exactBotProfile = this.agentStore.getByBotNpub(input.subscription.botNpub);
    if (
      exactBotProfile
      && exactBotProfile.managedByNpub === managerNpub
      && exactBotProfile.enabled
    ) {
      return exactBotProfile;
    }
    if (!managerNpub) return null;
    const defaultProfile = this.agentStore.getDefaultForManagerNpub(managerNpub);
    return defaultProfile?.enabled ? defaultProfile : null;
  }

  private buildMissingRouteHistoryEntry(input: DispatchPipelineEventInput): AgentChatDispatchHistoryEntry {
    return {
      at: new Date().toISOString(),
      kind: input.triggerKind === 'task_review' ? 'review' : input.triggerKind,
      action: `${input.triggerKind}_pipeline_route_missing`,
      agentId: 'pipeline',
      sessionId: null,
      recordId: input.recordId,
      routeId: null,
      pipelineRunId: null,
      status: 'suppressed',
      suppressionReason: 'pipeline_route_required',
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      sourceLabel: sourceLabelForDispatchInput(input),
      details: {
        capability: input.capability,
        trigger_kind: input.triggerKind,
        diagnostic_summary: 'No pipeline route is configured for this dispatch capability.',
      },
    };
  }

  private buildHistoryEntry(
    input: DispatchPipelineEventInput,
    route: DispatchRouteRecord,
    outcome: {
      action: string;
      status: string;
      pipelineRunId: string | null;
      concurrencyKey?: string | null;
      dedupeKey?: string | null;
      dedupeReason?: string | null;
      suppressionReason?: string | null;
      acknowledgement?: JsonObject | null;
      diagnosticSummary: string;
    },
  ): AgentChatDispatchHistoryEntry {
    const diagnosticSummary = appendAcknowledgementDiagnostic(outcome.diagnosticSummary, outcome.acknowledgement);
    return {
      at: new Date().toISOString(),
      kind: input.triggerKind === 'task_review' ? 'review' : input.triggerKind,
      action: outcome.action,
      agentId: 'pipeline',
      sessionId: null,
      recordId: input.recordId,
      routeId: route.routeId,
      pipelineRunId: outcome.pipelineRunId,
      status: outcome.status,
      concurrencyKey: outcome.concurrencyKey ?? null,
      dedupeKey: outcome.dedupeKey ?? null,
      dedupeReason: outcome.dedupeReason ?? null,
      suppressionReason: outcome.suppressionReason ?? null,
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      sourceLabel: sourceLabelForDispatchInput(input),
      details: {
        capability: input.capability,
        trigger_kind: input.triggerKind,
        pipeline_definition_id: route.pipelineDefinitionId,
        diagnostic_summary: diagnosticSummary,
        ...(outcome.acknowledgement ? { chat_acknowledgement: outcome.acknowledgement } : {}),
      },
    };
  }
}

async function acknowledgeChatPipelineMessage(input: DispatchChatAcknowledgementInput): Promise<JsonObject> {
  const channelId = input.eventInput.channelId ?? getText(input.eventInput.payload.channel_id);
  if (!channelId) {
    return buildFailedChatAcknowledgement(input.eventInput, 'missing_channel_id');
  }
  const runtimePrepared = input.flightDeckRuntime.mode === 'flightdeck_pg';
  if (!input.eventInput.botIdentity || !runtimePrepared) {
    return buildFailedChatAcknowledgement(
      input.eventInput,
      input.flightDeckRuntime.error ?? (
        !input.eventInput.botIdentity
          ? 'No runtime bot identity was available.'
          : 'Flight Deck runtime was not prepared.'
      ),
    );
  }
  return await acknowledgeChatDispatchMessage({
    eventInput: input.eventInput,
    agent: input.agent,
    botIdentity: input.eventInput.botIdentity,
    runtime: input.flightDeckRuntime,
  }, channelId);
}

async function resolveFlightDeckChannelContextFromTower(
  input: DispatchPipelineEventInput,
): Promise<DispatchFlightDeckChannelContext | null> {
  if (!requiresFlightDeckChannelContext(input)) {
    return null;
  }
  const workspaceId = getText(input.subscription.workspaceId);
  const backendBaseUrl = getText(input.subscription.backendBaseUrl);
  const appNpub = getText(input.subscription.sourceAppNpub);
  const scopeId = getText(input.scopeId ?? input.payload.scope_id);
  const channelId = getText(input.channelId ?? input.payload.channel_id);
  if (!workspaceId) {
    throw new Error('workspaceId is required for Flight Deck channel dispatch.');
  }
  if (!backendBaseUrl) {
    throw new Error('backendBaseUrl is required for Flight Deck channel dispatch.');
  }
  if (!appNpub) {
    throw new Error('sourceAppNpub is required for Flight Deck channel dispatch.');
  }
  if (!scopeId) {
    throw new Error('scopeId is required for Flight Deck channel dispatch.');
  }
  if (!channelId) {
    throw new Error('channelId is required for Flight Deck channel dispatch.');
  }
  if (!input.botIdentity) {
    throw new Error('bot identity is required to read Flight Deck channel context.');
  }
  const result = await fetchFlightDeckPgScopeChannels({
    backendBaseUrl,
    workspaceId,
    scopeId,
    appNpub,
    botIdentity: input.botIdentity,
  });
  const channel = result.channels.find((candidate) => getText(candidate.id) === channelId);
  if (!channel) {
    throw new Error(`Flight Deck channel not found in Tower: ${channelId}`);
  }
  return buildFlightDeckChannelContext(channel, scopeId);
}

function requiresFlightDeckChannelContext(input: DispatchPipelineEventInput): boolean {
  if (
    input.triggerKind !== 'chat'
    && input.triggerKind !== 'comment'
    && input.triggerKind !== 'task'
    && input.triggerKind !== 'document'
  ) {
    return false;
  }
  return Boolean(getText(input.subscription.workspaceId));
}

function buildFlightDeckChannelContext(
  channel: FlightDeckPgChannel,
  fallbackScopeId: string,
): DispatchFlightDeckChannelContext {
  const metadata = objectValue(channel.metadata);
  const contextPrompt = getText(metadata.basePrompt);
  const hasSpecificContext = Boolean(contextPrompt && contextPrompt !== 'No Specific Channel Context');
  return {
    id: getText(channel.id) ?? '',
    scopeId: getText(channel.scope_id) ?? fallbackScopeId,
    name: getText(channel.name),
    contextPrompt: contextPrompt ?? 'No Specific Channel Context',
    hasSpecificContext,
  };
}

function buildFailedChatAcknowledgement(input: DispatchPipelineEventInput, error: unknown): JsonObject {
  return {
    acknowledged: false,
    status: 'failed',
    operation: 'chat.acknowledge-message',
    emoji: 'shaka',
    targetMessageId: input.recordId,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function appendAcknowledgementDiagnostic(summary: string, acknowledgement: JsonObject | null | undefined): string {
  if (!acknowledgement || acknowledgement.status !== 'failed') {
    return summary;
  }
  const reason = getText(acknowledgement.reason) ?? 'unknown error';
  return `${summary} Chat acknowledgement failed: ${reason}`;
}

async function publishNeedsInputForRun(
  registry: FunctionRegistry,
  input: JsonObject,
): Promise<JsonObject | null> {
  const publishNeedsInput = registry['dispatch.publishNeedsInput'];
  if (!publishNeedsInput) {
    return null;
  }
  try {
    return objectValue(await publishNeedsInput(input)) as JsonObject;
  } catch (error) {
    return {
      published: false,
      status: 'failed',
      operation: 'tasks.needs-input',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDispatchEnvelope(input: {
  route: DispatchRouteRecord;
  input: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
  dedupeKey: string;
  concurrencyKey: string;
  flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
  flightDeckChannelContext: DispatchFlightDeckChannelContext | null;
  acknowledgement: JsonObject | null;
  defaultAgent: string;
  availablePipelines: PipelineDefinitionRecord[];
}): JsonObject {
  const { route, input: eventInput, agent, flightDeckRuntime } = input;
  return {
    ...route.inputTemplateJson,
    dispatch: {
      routeId: route.routeId,
      triggerKind: eventInput.triggerKind,
      receivedAt: new Date().toISOString(),
      dedupeKey: input.dedupeKey,
      concurrencyKey: input.concurrencyKey,
    },
    workspace: {
      workspaceOwnerNpub: getEffectiveWorkspaceNpub(eventInput.subscription),
      humanWorkspaceOwnerNpub: eventInput.subscription.workspaceOwnerNpub,
      workspaceServiceNpub: eventInput.subscription.workspaceServiceNpub ?? null,
      workspaceId: eventInput.subscription.workspaceId ?? null,
      sourceAppNpub: eventInput.subscription.sourceAppNpub,
      backendBaseUrl: eventInput.subscription.backendBaseUrl,
      subscriptionId: eventInput.subscription.subscriptionId,
    },
    agent: {
      profileId: agent?.agentId ?? null,
      agentId: agent?.agentId ?? null,
      label: agent?.publicProfile?.name?.trim() || agent?.label || null,
      botNpub: agent?.botNpub ?? null,
      workingDirectory: agent?.workingDirectory ?? null,
      defaultAgent: agent?.harness?.trim() || input.defaultAgent,
      model: agent?.model ?? null,
    },
    record: {
      recordId: eventInput.recordId,
      recordFamily: eventInput.recordFamily,
      recordState: eventInput.recordState,
      version: eventInput.recordVersion,
      updaterNpub: eventInput.updaterNpub,
      payload: eventInput.payload,
    },
    ...(eventInput.triggerKind === 'chat'
      ? {
          chat: {
            messageText: getText(eventInput.payload.body) ?? '',
            senderNpub: getText(eventInput.payload.sender_npub) ?? null,
            channelId: eventInput.channelId ?? getText(eventInput.payload.channel_id),
            threadId: eventInput.threadId ?? getText(eventInput.payload.thread_id),
            parentMessageId: getText(eventInput.payload.parent_message_id),
            attachments: Array.isArray(eventInput.payload.attachments) ? eventInput.payload.attachments : [],
          },
        }
      : {}),
    routing: {
      bindingId: eventInput.bindingId,
      bindingType: eventInput.bindingType,
      scopeId: eventInput.scopeId ?? null,
      channelId: eventInput.channelId ?? null,
      threadId: eventInput.threadId ?? null,
      changedFields: eventInput.changedFields ?? [],
    },
    flightDeckContext: {
      channel: input.flightDeckChannelContext,
    },
    workroomContext: eventInput.workroomContext ?? { isWorkroom: false },
    runtime: {
      mode: flightDeckRuntime.mode,
      yokeStateDir: flightDeckRuntime.yokeStateDir,
      commandPrefix: flightDeckRuntime.commandPrefix,
      commands: flightDeckRuntime.commands,
      error: flightDeckRuntime.error,
      persistParticipantMetadata: true,
      acknowledgement: input.acknowledgement,
      availablePipelines: input.availablePipelines.map((definition) => ({
        id: definition.id,
        slug: definition.slug,
        name: definition.name,
        scope: definition.scope,
        description: definition.spec.description ?? null,
      })),
    },
    profileRuntime: eventInput.profileRuntime
      ? {
          profileWorkspaceId: eventInput.profileRuntime.profileWorkspaceId,
          eventType: eventInput.profileRuntime.eventType,
          enabled: eventInput.profileRuntime.enabled,
          defaultAction: eventInput.profileRuntime.defaultAction,
          quietMode: eventInput.profileRuntime.quietMode,
          pipeline: eventInput.profileRuntime.pipeline,
          appendedContext: eventInput.profileRuntime.appendedContext,
        }
      : null,
  };
}

function buildProfilePolicyRoutes(input: DispatchPipelineEventInput, configuredRouteCount: number): DispatchRouteRecord[] {
  const profileRuntime = input.profileRuntime;
  const pipelineDefinitionId = getText(profileRuntime?.pipeline.pipelineDefinitionId);
  const managedByNpub = input.subscription.managedByNpub;
  if (!profileRuntime || !pipelineDefinitionId || !managedByNpub) {
    return [];
  }
  if (configuredRouteCount > 0 && profileRuntime.pipeline.source === 'built_in_default') {
    return [];
  }
  const now = new Date().toISOString();
  return [{
    routeId: [
      'profile-policy',
      input.subscription.subscriptionId,
      profileRuntime.eventType,
      profileRuntime.pipeline.source,
      pipelineDefinitionId,
    ].join(':'),
    managedByNpub,
    subscriptionId: input.subscription.subscriptionId,
    workspaceOwnerNpub: getEffectiveWorkspaceNpub(input.subscription),
    botNpub: input.subscription.botNpub,
    sourceAppNpub: input.subscription.sourceAppNpub,
    triggerKind: input.triggerKind,
    capability: input.capability,
    pipelineDefinitionId,
    pipelineVersionPolicy: profileRuntime.pipeline.pipelineVersionPolicy,
    enabled: profileRuntime.enabled && !profileRuntime.quietMode,
    priority: 0,
    matchJson: {},
    inputTemplateJson: {},
    concurrencyKeyTemplate: '${workspace.subscriptionId}:${record.bindingId}:${route.routeId}',
    activePolicy: 'skip',
    dedupeWindowSeconds: 300,
    createdAt: now,
    updatedAt: now,
  }];
}

function normaliseDefaultAgent(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : 'codex';
}

function emptyFlightDeckRuntime(): DispatchPipelineFlightDeckRuntime {
  return {
    mode: 'unavailable',
    yokeStateDir: null,
    commandPrefix: null,
    commands: {},
    error: null,
  };
}

function buildStoredRunDispatchContext(
  run: PipelineRunRecord,
  getBotIdentityForSubscription: (subscriptionId: string) => RuntimeBotIdentity | null,
): {
  eventInput: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
  flightDeckRuntime: DispatchPipelineFlightDeckRuntime;
} | null {
  const runInput = objectValue(run.input);
  const dispatch = objectValue(runInput.dispatch);
  const workspace = objectValue(runInput.workspace);
  const agentInput = objectValue(runInput.agent);
  const record = objectValue(runInput.record);
  const payload = objectValue(record.payload);
  const routing = objectValue(runInput.routing);
  const runtime = objectValue(runInput.runtime);
  const subscriptionId = getText(workspace.subscriptionId);
  if (!getText(dispatch.routeId) || !subscriptionId) {
    return null;
  }

  const botIdentity = getBotIdentityForSubscription(subscriptionId);
  const botNpub = getText(agentInput.botNpub) ?? botIdentity?.botNpub ?? '';
  const triggerKind = normaliseStoredTriggerKind(getText(dispatch.triggerKind));
  const flightDeckRuntime: DispatchPipelineFlightDeckRuntime = {
    mode: normaliseFlightDeckRuntimeMode(getText(runtime.mode), getText(workspace.workspaceId)),
    yokeStateDir: getText(runtime.yokeStateDir),
    commandPrefix: getText(runtime.commandPrefix),
    commands: objectValue(runtime.commands) as Record<string, string>,
    error: getText(runtime.error),
  };
  const agent = {
    agentId: getText(agentInput.agentId) ?? 'pipeline-agent',
    label: getText(agentInput.label) ?? null,
    botNpub,
    workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub) ?? '',
    groupNpubs: [],
    workingDirectory: getText(agentInput.workingDirectory) ?? process.cwd(),
    capabilities: [],
    enabled: true,
    createdAt: '',
    updatedAt: '',
    managedByNpub: run.ownerNpub,
  } as AgentDefinitionRecord;

  return {
    eventInput: {
      subscription: {
        subscriptionId,
        workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub) ?? '',
        sourceAppNpub: getText(workspace.sourceAppNpub) ?? '',
        backendBaseUrl: getText(workspace.backendBaseUrl) ?? '',
        workspaceId: getText(workspace.workspaceId),
        workspaceServiceNpub: getText(workspace.workspaceServiceNpub),
        botNpub,
        wsKeyNpub: '',
        managedByNpub: run.ownerNpub,
      } as WorkspaceSubscriptionRecord,
      triggerKind,
      capability: capabilityForStoredTrigger(triggerKind),
      recordId: getText(record.recordId) ?? getText(payload.record_id) ?? run.id,
      record: {},
      payload,
      recordFamily: getText(record.recordFamily) ?? triggerKind,
      recordState: getText(record.recordState),
      recordVersion: Number.isFinite(Number(record.version)) ? Number(record.version) : null,
      updaterNpub: getText(record.updaterNpub),
      bindingType: normaliseStoredBindingType(getText(routing.bindingType)),
      bindingId: getText(routing.bindingId),
      channelId: getText(routing.channelId),
      threadId: getText(routing.threadId),
      changedFields: getStringArray(routing.changedFields),
      groupNpubs: [],
      botIdentity,
    },
    agent,
    flightDeckRuntime,
  };
}

function routeMatchesEvent(route: DispatchRouteRecord, input: DispatchPipelineEventInput): boolean {
  const match = route.matchJson ?? {};
  const groups = getStringArray(match.groupNpubs);
  if (groups.length > 0 && !groups.includes('*')) {
    const eventGroups = new Set(input.groupNpubs ?? []);
    if (!groups.some((group) => eventGroups.has(group))) {
      return false;
    }
  }

  const states = getStringArray(match.taskStates ?? match.recordStates);
  if (states.length > 0 && !states.includes(String(input.payload.state ?? input.recordState ?? ''))) {
    return false;
  }

  const assignedTo = typeof match.assignedTo === 'string' ? match.assignedTo : null;
  if (assignedTo === 'bot' && String(input.payload.assigned_to ?? input.payload.assigned_to_npub ?? '') !== input.subscription.botNpub) {
    return false;
  }
  if (assignedTo && assignedTo !== 'any' && assignedTo !== 'bot' && String(input.payload.assigned_to ?? input.payload.assigned_to_npub ?? '') !== assignedTo) {
    return false;
  }

  const changedFields = getStringArray(match.changedFields);
  if (changedFields.length > 0) {
    const eventChanged = new Set(input.changedFields ?? []);
    if (!changedFields.some((field) => eventChanged.has(field))) {
      return false;
    }
  }

  return true;
}

function isSelfAuthoredChatEvent(
  input: DispatchPipelineEventInput,
  agent: AgentDefinitionRecord | null,
): boolean {
  if (input.triggerKind !== 'chat') return false;
  const selfNpubs = new Set(
    [
      input.subscription.botNpub,
      input.subscription.wsKeyNpub,
      agent?.botNpub,
    ].filter((value): value is string => Boolean(value)),
  );
  if (selfNpubs.size === 0) return false;
  const senderNpub = getText(input.payload.sender_npub);
  const updaterNpub = input.updaterNpub;
  return Boolean(
    (senderNpub && selfNpubs.has(senderNpub))
    || (updaterNpub && selfNpubs.has(updaterNpub)),
  );
}

function fallbackPipelineDefinitionId(route: DispatchRouteRecord): string | null {
  return stableDispatchPipelineIdForRoute(route);
}

function resolveRoutePipelineDefinitionId(route: Pick<DispatchRouteRecord, 'pipelineDefinitionId' | 'pipelineVersionPolicy' | 'triggerKind' | 'capability'>): string {
  const versionPolicy = normaliseRouteVersionPolicy(route.pipelineVersionPolicy);
  const stableBuiltIn = stableDispatchPipelineIdForRoute(route);
  const normalised = normaliseBuiltInDispatchPipelineId(route.pipelineDefinitionId) ?? route.pipelineDefinitionId;
  if (versionPolicy === 'latest' && stableBuiltIn && normalised === stableBuiltIn) {
    return stableBuiltIn;
  }
  return normalised;
}

function normaliseRouteVersionPolicy(value: string | null | undefined): DispatchPipelineVersionPolicy {
  return value === 'latest' ? 'latest' : DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY;
}

function getText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normaliseStoredTriggerKind(value: string | null): DispatchTriggerKind {
  if (
    value === 'chat'
    || value === 'task'
    || value === 'document'
    || value === 'flow'
    || value === 'task_review'
    || value === 'approval'
    || value === 'comment'
  ) {
    return value;
  }
  return 'task';
}

function normaliseFlightDeckRuntimeMode(
  value: string | null,
  workspaceId: string | null,
): DispatchPipelineFlightDeckRuntime['mode'] {
  if (value === 'flightdeck_pg' || value === 'yoke' || value === 'unavailable') {
    return value === 'yoke' ? 'unavailable' : value;
  }
  return workspaceId ? 'flightdeck_pg' : 'unavailable';
}

function capabilityForStoredTrigger(triggerKind: DispatchTriggerKind): AgentCapability {
  if (triggerKind === 'chat') return 'chat_intercept';
  if (triggerKind === 'comment') return 'comment_dispatch';
  if (triggerKind === 'approval') return 'approval_dispatch';
  if (triggerKind === 'flow') return 'flow_dispatch';
  if (triggerKind === 'task_review') return 'task_review';
  if (triggerKind === 'document') return 'task_dispatch';
  return 'task_dispatch';
}

function normaliseStoredBindingType(value: string | null): AgentChatDispatchHistoryEntry['bindingType'] {
  if (
    value === 'chat'
    || value === 'task'
    || value === 'document'
    || value === 'flow_run'
    || value === 'thread'
  ) {
    return value;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getDispatchRunDedupeKey(run: PipelineRunRecord): string | null {
  return getText(objectValue(run.input.dispatch).dedupeKey);
}

function getDispatchRunConcurrencyKey(run: PipelineRunRecord): string | null {
  return getText(objectValue(run.input.dispatch).concurrencyKey);
}

function getDispatchRunRouteId(run: PipelineRunRecord): string | null {
  return getText(objectValue(run.input.dispatch).routeId);
}

function dispatchRunMatchesRoute(run: PipelineRunRecord, route: DispatchRouteRecord): boolean {
  const routeId = getDispatchRunRouteId(run);
  if (routeId) {
    return routeId === route.routeId;
  }
  return run.definitionId === route.pipelineDefinitionId;
}

function getRunLastActivityMs(run: PipelineRunRecord): number {
  const timestamp = Date.parse(run.completedAt ?? run.startedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
    : [];
}

function buildDedupeKey(input: DispatchPipelineEventInput, route: DispatchRouteRecord): string {
  return [
    input.subscription.subscriptionId,
    getEffectiveWorkspaceNpub(input.subscription),
    input.subscription.sourceAppNpub,
    input.recordId,
    input.recordVersion ?? 'unknown',
    input.bindingId ?? 'none',
    route.routeId,
  ].join(':');
}

function getEffectiveWorkspaceNpub(subscription: Pick<WorkspaceSubscriptionRecord, 'workspaceOwnerNpub' | 'workspaceServiceNpub'>): string {
  return subscription.workspaceServiceNpub?.trim() || subscription.workspaceOwnerNpub;
}

function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
    const parts = String(path).split('.');
    let current: unknown = values;
    for (const part of parts) {
      if (!current || typeof current !== 'object') {
        return '';
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current == null ? '' : String(current);
  });
}
