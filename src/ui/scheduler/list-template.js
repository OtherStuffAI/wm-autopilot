/**
 * Trigger page chrome and list template: header, search/filter toolbar,
 * status feedback, trigger cards, inline confirmations and run history.
 */

import { STATUS_FILTERS, TYPE_FILTERS } from "./trigger-view.js";
import { renderTriggerForm } from "./form-template.js";

function options(pairs) {
  return pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

function header() {
  return `<div class="wm-scheduler-header">
    <div class="wm-scheduler-heading">
      <h2>Triggers</h2>
      <p class="wm-trigger-help" data-testid="scheduler-counts" x-text="countsText"></p>
    </div>
    <button type="button" class="wm-btn wm-btn--sm" @click="refresh()" :disabled="$store.scheduler.syncing" data-testid="scheduler-refresh">
      <span x-text="$store.scheduler.syncing ? 'Refreshing…' : 'Refresh'"></span>
    </button>
    <button type="button" class="wm-btn wm-btn--sm wm-btn--primary" id="scheduler-new-trigger" data-testid="scheduler-new-trigger"
      :aria-expanded="showForm ? 'true' : 'false'" aria-controls="scheduler-create-panel" @click="toggleCreate()">
      <span x-text="showForm ? 'Cancel' : '+ New trigger'"></span>
    </button>
  </div>`;
}

function toolbar() {
  return `<div class="wm-trigger-toolbar" role="search" x-show="$store.scheduler.jobs.length > 0">
    <label class="wm-trigger-toolbar-search">
      <span class="wm-sr-only">Search triggers</span>
      <input type="search" class="wm-input" x-model.debounce.150ms="filters.query" placeholder="Search name, directory, prompt…" data-testid="scheduler-search">
    </label>
    <label><span class="wm-sr-only">Filter by status</span>
      <select class="wm-select" x-model="filters.status" data-testid="scheduler-filter-status">${options(STATUS_FILTERS)}</select></label>
    <label><span class="wm-sr-only">Filter by trigger type</span>
      <select class="wm-select" x-model="filters.type" data-testid="scheduler-filter-type">${options(TYPE_FILTERS)}</select></label>
    <button type="button" class="wm-btn wm-btn--sm" x-show="filtersActive" @click="clearFilters()">Clear filters</button>
    <p class="wm-trigger-help" role="status" aria-live="polite" x-text="resultsText"></p>
    <p class="wm-trigger-help" data-testid="scheduler-display-timezone" x-text="'Next run, last run and history times are shown in ' + $store.scheduler.displayTimezone + ' (this browser). Each schedule runs in its own timezone.'"></p>
  </div>`;
}

function feedback() {
  return `<div class="wm-trigger-banner wm-trigger-banner--error" role="alert" x-show="$store.scheduler.syncError" data-testid="scheduler-sync-error">
    <span>Couldn't refresh triggers: <span x-text="$store.scheduler.syncError"></span>. Showing the last saved list.</span>
    <button type="button" class="wm-btn wm-btn--sm" @click="refresh()">Retry</button>
  </div>
  <p class="wm-trigger-state" role="status" x-show="$store.scheduler.loading" data-testid="scheduler-loading">Loading triggers…</p>
  <div class="wm-trigger-empty" x-show="!$store.scheduler.loading && $store.scheduler.jobs.length === 0 && !showForm" data-testid="scheduler-empty">
    <h3>No triggers yet</h3>
    <p>A trigger starts an agent session or pipeline for you — on a schedule, or when files in a folder change.</p>
    <button type="button" class="wm-btn wm-btn--primary" @click="toggleCreate()">Create your first trigger</button>
  </div>
  <div class="wm-trigger-empty" x-show="!$store.scheduler.loading && $store.scheduler.jobs.length > 0 && visibleJobs.length === 0" data-testid="scheduler-no-matches">
    <h3>No triggers match</h3>
    <p>Try a different search or clear the filters.</p>
    <button type="button" class="wm-btn" @click="clearFilters()">Clear filters</button>
  </div>`;
}

function confirmation() {
  return `<div class="wm-trigger-confirm" role="group" :aria-label="confirmLabel(job)" x-show="pending.id === job.id">
    <p x-text="confirmText(job)"></p>
    <button type="button" class="wm-btn wm-btn--sm" :class="pending.kind === 'delete' ? 'wm-btn--danger' : 'wm-btn--primary'"
      :data-confirm="job.id" @click="confirmPending(job)" x-text="pending.kind === 'delete' ? 'Delete trigger' : 'Run now'"></button>
    <button type="button" class="wm-btn wm-btn--sm" @click="cancelPending(job)">Cancel</button>
  </div>`;
}

function runHistory() {
  return `<div class="wm-trigger-runs" x-show="runsJobId === job.id" role="region" :aria-label="'Run history for ' + job.name">
    <div class="wm-trigger-runs-head"><strong>Run history</strong> <span class="wm-trigger-meta" x-text="'Times in ' + $store.scheduler.displayTimezone"></span>
      <button type="button" class="wm-btn wm-btn--sm" @click="closeRuns(job)">Close</button></div>
    <p class="wm-trigger-state" role="status" x-show="loadingRuns">Loading runs…</p>
    <div class="wm-trigger-banner wm-trigger-banner--error" role="alert" x-show="runsError">
      <span x-text="runsError"></span><button type="button" class="wm-btn wm-btn--sm" @click="showRuns(job)">Retry</button></div>
    <p class="wm-trigger-state" x-show="!loadingRuns && !runsError && runs.length === 0">This trigger hasn't run yet.</p>
    <ul class="wm-trigger-run-list" x-show="!loadingRuns && runs.length > 0">
      <template x-for="run in runs" :key="run.id">
        <li>
          <span class="wm-trigger-badge" :class="'wm-trigger-badge--run-' + (run.status === 'success' && run.sessionId ? 'launched' : run.status)" x-text="run.statusLabel || (run.status === 'success' && run.sessionId ? 'Launched (legacy)' : run.status)"></span>
          <span class="wm-trigger-meta" data-testid="scheduler-run-outcome" x-text="run.statusDetail || (run.sessionId ? 'Runtime completion and delivery are unverified.' : '')"></span>
          <span class="wm-trigger-meta" x-text="formatTime(run.startedAt)"></span>
          <a x-show="run.sessionId" :href="'/live/' + run.sessionId" class="wm-trigger-link" x-text="'Session ' + (run.sessionId || '').slice(0, 8) + '…'"></a>
          <a x-show="run.pipelineRunId" :href="'/pipelines/runs/' + run.pipelineRunId" class="wm-trigger-link" x-text="'Pipeline run ' + (run.pipelineRunId || '').slice(0, 8) + '…'"></a>
          <span class="wm-trigger-run-error" x-show="run.errorMessage" x-text="run.errorMessage"></span>
        </li>
      </template>
    </ul>
  </div>`;
}

function card() {
  return `<article class="wm-trigger-card" :class="'wm-trigger-card--' + jobStatus(job).key" :aria-label="'Trigger ' + job.name" :data-job-id="job.id">
    <div class="wm-trigger-card-head">
      <button type="button" role="switch" class="wm-trigger-switch" :aria-checked="job.enabled ? 'true' : 'false'"
        :aria-label="'Enabled: ' + job.name" :disabled="job.triggerType === 'unsupported'"
        :title="job.triggerType === 'unsupported' ? job.unsupportedReason : (job.enabled ? 'Disable trigger' : 'Enable trigger')"
        @click="toggleEnabled(job)"><span class="wm-trigger-switch-knob"></span></button>
      <div class="wm-trigger-card-title">
        <h3 x-text="job.name"></h3>
        <div class="wm-trigger-badges">
          <span class="wm-trigger-badge" :class="'wm-trigger-badge--' + jobStatus(job).key" x-text="jobStatus(job).label"></span>
          <span class="wm-trigger-badge" x-show="job.triggerType !== 'unsupported'" x-text="triggerKindLabel(job.triggerType)"></span>
          <span class="wm-trigger-badge" x-text="actionKindLabel(job.actionType || 'session')"></span>
        </div>
      </div>
    </div>

    <dl class="wm-trigger-facts">
      <div><dt>When</dt><dd x-text="describeJobWhen(job)"></dd></div>
      <div x-show="job.activeStartTime && job.activeEndTime"><dt>Window</dt><dd x-text="describeActiveWindow(job.activeStartTime, job.activeEndTime, job.timezone)"></dd></div>
      <div><dt>Does</dt><dd x-text="describeJobWhat(job, (id) => pipelineName(id))"></dd></div>
      <div x-show="job.actionType !== 'cleanup'" data-testid="scheduler-saved-identity">
        <dt>Run as</dt>
        <dd><span x-text="identityName(job.botNpub)"></span>
          <details class="wm-trigger-inline-details"><summary aria-label="Inspect saved Run as npub">npub</summary><code x-text="job.botNpub || 'Identity missing'"></code></details></dd>
      </div>
      <div x-show="job.nextRunAt && job.triggerType === 'cron' && job.enabled"><dt>Next run</dt><dd x-text="formatTime(job.nextRunAt)"></dd></div>
      <div><dt>Last run</dt><dd x-text="job.lastRunAt ? formatTime(job.lastRunAt) : 'Never'"></dd></div>
    </dl>

    <div class="wm-trigger-banner" role="status" x-show="job.triggerType === 'unsupported' && editingJobId !== job.id" x-text="job.unsupportedReason"></div>

    <div class="wm-trigger-card-actions" x-show="editingJobId !== job.id">
      <button type="button" class="wm-btn wm-btn--sm" :data-edit-btn="job.id" @click="startEdit(job)" x-show="job.triggerType !== 'unsupported'" :aria-label="'Edit ' + job.name">Edit</button>
      <button type="button" class="wm-btn wm-btn--sm" @click="runsJobId === job.id ? closeRuns(job) : showRuns(job)" :aria-expanded="runsJobId === job.id ? 'true' : 'false'" :aria-label="'Run history for ' + job.name">History</button>
      <button type="button" class="wm-btn wm-btn--sm" @click="askConfirm(job, 'run')" :disabled="job.triggerType === 'unsupported'" :aria-label="'Run ' + job.name + ' now'">Run now</button>
      <button type="button" class="wm-btn wm-btn--sm wm-btn--danger" @click="askConfirm(job, 'delete')" :aria-label="'Delete ' + job.name">Delete</button>
    </div>
    ${confirmation()}

    <template x-if="editingJobId !== job.id && (job.actionType || 'session') === 'session'">
      <details class="wm-trigger-details"><summary>Prompt</summary><pre x-text="job.initialPrompt"></pre></details>
    </template>
    <template x-if="editingJobId !== job.id && (job.actionType || 'session') === 'pipeline'">
      <details class="wm-trigger-details"><summary>Pipeline input</summary><pre x-text="formatPipelineInput(job.pipelineInputJson)"></pre></details>
    </template>
    <details class="wm-trigger-details" x-show="editingJobId !== job.id">
      <summary>Trigger ID</summary>
      <div class="wm-trigger-id"><code x-text="job.id"></code>
        <button type="button" class="wm-btn wm-btn--sm" @click="copyToClipboard(job.id, 'Trigger ID')">Copy</button></div>
    </details>

    ${runHistory()}

    <template x-if="editingJobId === job.id">
      <div class="wm-trigger-edit" role="region" :aria-label="'Edit ' + job.name">${renderTriggerForm("edit")}</div>
    </template>
  </article>`;
}

export function getPageTemplate() {
  return `
  ${header()}
  <datalist id="scheduler-timezones">
    <template x-for="zone in timezoneSuggestions" :key="zone"><option :value="zone"></option></template>
  </datalist>
  <div class="wm-trigger-panel" id="scheduler-create-panel" x-show="showForm">
    <template x-if="showForm"><div><h3 class="wm-trigger-panel-title">New trigger</h3>${renderTriggerForm("create")}</div></template>
  </div>
  ${toolbar()}
  ${feedback()}
  <div class="wm-trigger-list" data-testid="scheduler-list">
    <template x-for="job in visibleJobs" :key="job.id">
      ${card()}
    </template>
  </div>`;
}
