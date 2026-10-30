/**
 * Trigger form template, rendered once for create and once for inline edit.
 * Both modes share markup; `names` maps the shared template onto the page's
 * create/edit Alpine state so payload building stays in page.js.
 */

import { renderAgentOptions } from "../common/agent-options.js";
import { runIdentityField } from "./run-identity.js";
import { CUSTOM_FREQUENCY_LABEL, FREQUENCY_OPTIONS, WEEKDAY_OPTIONS } from "./schedule-helpers.js";

const NAMES = {
  create: {
    mode: "create", edit: "false", form: "form", action: "actionType", trigger: "triggerType", sched: "sched",
    isCron: "isCron", isFile: "isFileWatcher", isSession: "isSessionAction", isPipeline: "isPipelineAction",
    isCleanup: "isCleanupAction", needsTime: "needsTime", needsHour: "needsHour", needsWeekday: "needsWeekday",
    cronText: "cronDescription", draft: "createSummary", submit: "submitJob()", cancel: "cancelCreate()",
    submitting: "submitting", submitLabel: "Create trigger", busyLabel: "Creating…",
  },
  edit: {
    mode: "edit", edit: "true", form: "editForm", action: "editActionType", trigger: "editTriggerType", sched: "editSched",
    isCron: "editIsCron", isFile: "editIsFileWatcher", isSession: "editIsSessionAction", isPipeline: "editIsPipelineAction",
    isCleanup: "editIsCleanupAction", needsTime: "editNeedsTime", needsHour: "editNeedsHour", needsWeekday: "editNeedsWeekday",
    cronText: "editCronDescription", draft: "editSummary", submit: "saveEdit()", cancel: "cancelEdit()",
    submitting: "editSubmitting", submitLabel: "Save changes", busyLabel: "Saving…",
  },
};

function hourOptions() {
  return Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}</option>`).join("");
}

function minuteOptions() {
  return Array.from({ length: 12 }, (_, i) => `<option value="${i * 5}">${String(i * 5).padStart(2, "0")}</option>`).join("");
}

function options(pairs) {
  return pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

/** A labelled field with help text and an inline, aria-linked error. */
function field(n, { key, label, help = "", optional = false, show = "", control }) {
  const id = `scheduler-${n.mode}-${key}`;
  const attrs = `id="${id}" data-field="${key}" aria-describedby="${id}-help ${id}-error" :aria-invalid="fieldError(${n.edit}, '${key}') ? 'true' : 'false'"`;
  return `<div class="wm-form-group wm-trigger-field" ${show ? `x-show="${show}"` : ""}>
    <label for="${id}">${label}${optional ? ' <span class="wm-trigger-optional">(optional)</span>' : ""}</label>
    ${control(attrs, id)}
    ${help ? `<p class="wm-trigger-help" id="${id}-help">${help}</p>` : `<span id="${id}-help" hidden></span>`}
    <p class="wm-trigger-error" id="${id}-error" x-show="fieldError(${n.edit}, '${key}')" x-text="fieldError(${n.edit}, '${key}')"></p>
  </div>`;
}

function choice(n, { group, value, title, hint, disabled = "" }) {
  const model = group === "trigger" ? n.trigger : n.action;
  const change = group === "action" ? ` @change="onActionChange(${n.edit})"` : "";
  return `<label class="wm-trigger-choice" :class="{ 'is-disabled': ${disabled || "false"} }">
    <input type="radio" name="scheduler-${n.mode}-${group}" value="${value}" x-model="${model}"${change}
      ${disabled ? `:disabled="${disabled}"` : ""} data-testid="scheduler-${n.mode}-${group}-${value}">
    <span class="wm-trigger-choice-title">${title}</span>
    <span class="wm-trigger-choice-hint">${hint}</span>
  </label>`;
}

function whenSection(n) {
  return `<fieldset class="wm-trigger-section">
    <legend><span class="wm-trigger-step">1</span> When should it run?</legend>
    <div class="wm-trigger-choices" role="radiogroup" aria-label="Trigger type">
      ${choice(n, { group: "trigger", value: "cron", title: "On a schedule", hint: "Run at set times, such as daily at 09:00." })}
      ${choice(n, { group: "trigger", value: "file_watcher", title: "When files change", hint: "Run when a file in a folder is added or changed.", disabled: n.isCleanup })}
    </div>
    <p class="wm-trigger-help" x-show="${n.isCleanup}">Cleanup always runs on a schedule.</p>

    <template x-if="${n.isCron}">
      <div class="wm-trigger-subgroup">
        <div class="wm-form-group wm-trigger-field">
          <label for="scheduler-${n.mode}-frequency">Repeat</label>
          <div class="wm-trigger-schedule-row">
            <select id="scheduler-${n.mode}-frequency" class="wm-select" x-model="${n.sched}.frequency" data-testid="scheduler-${n.mode}-frequency">${options(FREQUENCY_OPTIONS)}<template x-if="${n.sched}.frequency === 'custom'"><option value="custom">${CUSTOM_FREQUENCY_LABEL}</option></template></select>
            <template x-if="${n.needsWeekday}">
              <select class="wm-select" x-model="${n.sched}.weekday" aria-label="Day of week">${options(WEEKDAY_OPTIONS)}</select>
            </template>
            <template x-if="${n.needsTime}">
              <span class="wm-trigger-schedule-at">
                <span aria-hidden="true">at</span>
                <template x-if="${n.needsHour}"><select class="wm-select" x-model.number="${n.sched}.hour" aria-label="Hour">${hourOptions()}</select></template>
                <template x-if="${n.needsHour}"><span aria-hidden="true">:</span></template>
                <select class="wm-select" x-model.number="${n.sched}.minute" :aria-label="${n.needsHour} ? 'Minute' : 'Minutes past the hour'">${minuteOptions()}</select>
              </span>
            </template>
          </div>
          <p class="wm-trigger-help" x-text="${n.cronText}"></p>
        </div>
        ${field(n, {
          key: "timezone", label: "Timezone",
          help: "Schedule times use this IANA timezone, for example Europe/London or UTC.",
          control: (attrs) => `<input type="text" class="wm-input wm-trigger-tz" ${attrs} x-model="${n.form}.timezone" list="scheduler-timezones" autocomplete="off" spellcheck="false" @blur="touch(${n.edit}, 'timezone')">`,
        })}
      </div>
    </template>

    <template x-if="${n.isFile}">
      <div class="wm-trigger-subgroup wm-scheduler-grid-split">
        ${field(n, {
          key: "watchDirectory", label: "Folder to watch",
          help: "Triggers when a matching file in this folder is added or changed.",
          control: (attrs) => `<div class="wm-scheduler-path-field">
            <input type="text" class="wm-input" ${attrs} x-model="${n.form}.watchDirectory" placeholder="/path/to/watch"
              data-ac="${n.mode}-watchdir" list="${n.mode}-watchdir-suggestions" autocomplete="off" data-testid="scheduler-${n.mode}-watch-directory" @blur="touch(${n.edit}, 'watchDirectory')">
            <button type="button" class="wm-btn wm-btn--sm" @click="browseDirectory(${n.form}, 'watchDirectory', 'Select Watch Directory')"
              aria-label="Browse for folder to watch" data-testid="scheduler-${n.mode}-watch-directory-browse">Browse…</button>
          </div>
          <datalist id="${n.mode}-watchdir-suggestions" data-ac="${n.mode}-watchdir-list"></datalist>`,
        })}
        ${field(n, {
          key: "filePattern", label: "File pattern", optional: true,
          help: "Glob such as *.json. Use * for every file.",
          control: (attrs) => `<input type="text" class="wm-input" ${attrs} x-model="${n.form}.filePattern" placeholder="*.json">`,
        })}
      </div>
    </template>
  </fieldset>`;
}

function whatSection(n) {
  return `<fieldset class="wm-trigger-section">
    <legend><span class="wm-trigger-step">2</span> What should it do?</legend>
    <div class="wm-trigger-choices" role="radiogroup" aria-label="Action">
      ${choice(n, { group: "action", value: "session", title: "Start an agent session", hint: "An agent works on a prompt in a directory." })}
      ${choice(n, { group: "action", value: "pipeline", title: "Run a pipeline", hint: "Run a saved pipeline with JSON input." })}
      ${choice(n, { group: "action", value: "cleanup", title: "Clean up sessions", hint: "Stop finished or stale automatic sessions." })}
    </div>

    <div class="wm-trigger-subgroup wm-scheduler-grid-fields" x-show="${n.isSession}">
      <div class="wm-form-group wm-trigger-field">
        <label for="scheduler-${n.mode}-agent">Engine</label>
        <select id="scheduler-${n.mode}-agent" class="wm-select" x-model="${n.form}.agent" @change="syncModel(${n.form})" data-testid="scheduler-${n.mode}-agent">${renderAgentOptions()}</select>
      </div>
      <div class="wm-form-group wm-trigger-field">
        <label for="scheduler-${n.mode}-model">Model</label>
        <select id="scheduler-${n.mode}-model" class="wm-select" x-model="${n.form}.model" data-testid="scheduler-${n.mode}-model">
          <template x-for="model in modelOptions(${n.form}.agent)" :key="model"><option :value="model" x-text="getModelOptionLabel(model)"></option></template>
        </select>
      </div>
    </div>
    ${field(n, {
      key: "workingDirectory", label: "Working directory", show: n.isSession,
      help: "The agent starts in this directory.",
      control: (attrs) => `<div class="wm-scheduler-path-field">
        <input type="text" class="wm-input" ${attrs} x-model="${n.form}.workingDirectory" placeholder="/path/to/project"
          data-ac="${n.mode}-workdir" list="${n.mode}-workdir-suggestions" autocomplete="off" data-testid="scheduler-${n.mode}-working-directory" @blur="touch(${n.edit}, 'workingDirectory')">
        <button type="button" class="wm-btn wm-btn--sm" @click="browseDirectory(${n.form}, 'workingDirectory', 'Select Working Directory')"
          aria-label="Browse for working directory" data-testid="scheduler-${n.mode}-working-directory-browse">Browse…</button>
      </div>
      <datalist id="${n.mode}-workdir-suggestions" data-ac="${n.mode}-workdir-list"></datalist>`,
    })}
    ${field(n, {
      key: "initialPrompt", label: "Prompt", show: n.isSession,
      help: "Sent to the agent each time the trigger runs.",
      control: (attrs) => `<textarea class="wm-input" ${attrs} x-model="${n.form}.initialPrompt" rows="4" placeholder="What should the agent do?" @blur="touch(${n.edit}, 'initialPrompt')"></textarea>`,
    })}

    <div class="wm-trigger-subgroup wm-scheduler-grid-fields" x-show="${n.isPipeline}">
      ${field(n, {
        key: "pipelineDefinitionId", label: "Pipeline",
        control: (attrs) => `<select class="wm-select" ${attrs} x-model="${n.form}.pipelineDefinitionId" @change="setPipelineDefaultInput(${n.edit}); touch(${n.edit}, 'pipelineDefinitionId')">
          <option value="">Select a pipeline…</option>
          <template x-for="definition in pipelineDefinitions" :key="definition.id"><option :value="definition.id" x-text="definition.name"></option></template>
        </select>`,
        help: "Picking a pipeline fills in its default input.",
      })}
      ${field(n, {
        key: "pipelineAgent", label: "Pipeline engine", optional: true,
        control: (attrs) => `<select class="wm-select" ${attrs} x-model="${n.form}.pipelineAgent" data-testid="scheduler-${n.mode}-pipeline-engine">
          <option value="">Use pipeline default</option>${renderAgentOptions()}</select>`,
      })}
    </div>
    ${field(n, {
      key: "pipelineInput", label: "Pipeline input (JSON)", show: n.isPipeline,
      help: "A JSON object passed to the pipeline, for example {}.",
      control: (attrs) => `<textarea class="wm-input wm-trigger-mono" ${attrs} x-model="${n.form}.pipelineInput" rows="7" spellcheck="false" @blur="touch(${n.edit}, 'pipelineInput')"></textarea>`,
    })}

    <p class="wm-trigger-note" x-show="${n.isCleanup}">
      Stops automatic sessions marked nextAction=stop, plus prompt-ready automatic sessions inactive for over 60 minutes.
      Cleanup does not use a Run as identity.
    </p>
  </fieldset>`;
}

function advancedSection(n) {
  return `<details class="wm-trigger-advanced" :open="hasActiveWindow(${n.edit})">
    <summary>Active window <span class="wm-trigger-optional">(optional)</span></summary>
    <template x-if="${n.isFile}">
      ${field(n, {
        key: "timezone", label: "Timezone",
        help: "The active window uses this IANA timezone, for example Europe/London or UTC.",
        control: (attrs) => `<input type="text" class="wm-input wm-trigger-tz" ${attrs} x-model="${n.form}.timezone" list="scheduler-timezones" autocomplete="off" spellcheck="false" @blur="touch(${n.edit}, 'timezone')">`,
      })}
    </template>
    <div class="wm-form-group wm-trigger-field" data-field="activeWindow" id="scheduler-${n.mode}-activeWindow">
      <div class="wm-trigger-window-row" role="group" aria-label="Active window" aria-describedby="scheduler-${n.mode}-window-help scheduler-${n.mode}-activeWindow-error">
        <label>From <input type="time" class="wm-input" x-model="${n.form}.activeStartTime" aria-label="Active window start"></label>
        <label>to <input type="time" class="wm-input" x-model="${n.form}.activeEndTime" aria-label="Active window end"></label>
        <button type="button" class="wm-btn wm-btn--sm" x-show="hasActiveWindow(${n.edit})" @click="clearActiveWindow(${n.edit})">Clear</button>
      </div>
      <p class="wm-trigger-help" id="scheduler-${n.mode}-window-help" x-text="activeWindowHelp(${n.edit})"></p>
      <p class="wm-trigger-error" id="scheduler-${n.mode}-activeWindow-error" x-show="fieldError(${n.edit}, 'activeWindow')" x-text="fieldError(${n.edit}, 'activeWindow')"></p>
    </div>
  </details>`;
}

/** Render the shared form for "create" or "edit". */
export function renderTriggerForm(mode) {
  const n = NAMES[mode];
  return `<form class="wm-trigger-form" novalidate aria-label="${mode === "edit" ? "Edit trigger" : "New trigger"}"
      @submit.prevent="${n.submit}" data-testid="scheduler-${n.mode}-form">
    <div class="wm-trigger-summary-errors" role="alert" tabindex="-1" data-error-summary x-show="errorSummary(${n.edit})" x-text="errorSummary(${n.edit})"></div>

    ${field(n, {
      key: "name", label: "Name",
      help: "Shown in the trigger list and run history.",
      control: (attrs) => `<input type="text" class="wm-input" ${attrs} x-model="${n.form}.name" placeholder="e.g. Daily code review" autocomplete="off" @blur="touch(${n.edit}, 'name')">`,
    })}
    ${whenSection(n)}
    ${whatSection(n)}
    <div class="wm-trigger-section" x-show="!${n.isCleanup}">
      <h4 class="wm-trigger-section-title"><span class="wm-trigger-step">3</span> Who runs it?</h4>
      ${runIdentityField(mode === "edit")}
      <p class="wm-trigger-help">Runs use this identity's permissions. Only identities you own are listed.</p>
    </div>
    ${advancedSection(n)}

    <p class="wm-trigger-draft" aria-live="polite"><strong>Summary:</strong> <span x-text="${n.draft}"></span></p>

    <div class="wm-trigger-actions">
      <button type="button" class="wm-btn" @click="${n.cancel}">Cancel</button>
      <button type="submit" class="wm-btn wm-btn--primary" :disabled="${n.submitting}" data-testid="scheduler-${n.mode}-submit">
        <span x-text="${n.submitting} ? '${n.busyLabel}' : '${n.submitLabel}'"></span>
      </button>
    </div>
  </form>`;
}
