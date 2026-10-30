import { identityIssue, identityName } from "./run-identity.js";
/**
 * Scheduler Page
 *
 * Dedicated page for managing scheduled agent jobs.
 * Uses Alpine.js for reactive UI backed by Dexie IndexedDB cache.
 *
 * Exports initSchedulerPage({ showToast }) returning
 * { renderPage, ensureLoaded }.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { fetchSchedulerJobRuns } from "./api.js";
import { fetchPipelineDefinitions } from "../pipelines/api.js";
import { attachDirAutocomplete } from "./dir-autocomplete.js";
import { DEFAULT_AGENT, normalizeAgentValue } from "../common/agent-options.js";
import { state } from "../state/index.js";
import { createSchedulerFormSupport } from "./form-support.js";
import {
  DEFAULT_SCHEDULE,
  buildCron,
  describeCron,
  frequencyNeedsHour,
  frequencyNeedsTime,
  parseCron,
} from "./schedule-helpers.js";
import {
  FIELD_LABELS,
  actionKindLabel,
  countJobs,
  describeActiveWindow,
  describeDraft,
  describeJobWhat,
  describeJobWhen,
  filterJobs,
  firstInvalidField,
  jobStatus,
  triggerKindLabel,
  validateTriggerForm,
} from "./trigger-view.js";
import { getPageTemplate } from "./list-template.js";

function listTimezones() {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return ["UTC"];
  }
}

function getConfiguredDefaultAgent() {
  return normalizeAgentValue(state.config?.defaultAgent ?? state.config?.systemDefaultAgent ?? DEFAULT_AGENT);
}

// ============================================================
// Page Module
// ============================================================

export function initSchedulerPage({ showToast, openDirectoryBrowser }) {
  const formSupport = createSchedulerFormSupport({
    getConfig: () => state.config,
    getDefaultAgent: getConfiguredDefaultAgent,
    openDirectoryBrowser,
  });

  async function ensureLoaded() {
    const store = Alpine.store("scheduler");
    if (store) {
      await store.init();
    }
  }

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-scheduler-page wm-page";
    page.setAttribute("x-data", "schedulerPage");
    page.innerHTML = getPageTemplate();
    return page;
  }

  Alpine.data("schedulerPage", () => ({
    ...formSupport,

    identityIssue(action, npub) {
      const store = this.$store.scheduler;
      return identityIssue(action, npub, store.identities, store.identityStatus);
    },

    identityName(npub) {
      const store = this.$store.scheduler;
      return identityName(npub, store.identities, store.identityStatus);
    },

    root: null,

    // Autocomplete cleanup handles
    _acCleanups: [],

    // List filtering and pending confirmations
    filters: { query: "", status: "all", type: "all" },
    pending: { id: null, kind: null },
    timezoneSuggestions: listTimezones(),

    // Validation display state per form (errors appear after blur or a submit attempt)
    touchState: { create: { attempted: false, touched: {} }, edit: { attempted: false, touched: {} } },

    // Create form state
    showForm: false,
    actionType: "session",
    triggerType: "cron",
    pipelineDefinitions: [],
    form: formSupport.createFormValues(),
    // Schedule picker state (separate from form to keep API payload clean)
    sched: { ...DEFAULT_SCHEDULE },
    submitting: false,

    // Edit state
    editingJobId: null,
    editActionType: "session",
    editTriggerType: "cron",
    editForm: {},
    editSched: {},
    editSubmitting: false,

    // Run history
    runsJobId: null,
    runs: [],
    loadingRuns: false,
    runsError: "",

    // Template helpers
    jobStatus,
    triggerKindLabel,
    actionKindLabel,
    describeJobWhen,
    describeJobWhat,
    describeActiveWindow,

    get isCron() {
      return this.triggerType === "cron";
    },

    get isPipelineAction() {
      return this.actionType === "pipeline";
    },

    get isSessionAction() {
      return this.actionType === "session";
    },

    get isCleanupAction() {
      return this.actionType === "cleanup";
    },

    get isFileWatcher() {
      return this.triggerType === "file_watcher";
    },

    get computedCron() {
      return buildCron(this.sched.frequency, this.sched.hour, this.sched.minute, this.sched.weekday);
    },

    get cronDescription() {
      return describeCron(this.computedCron);
    },

    get needsTime() {
      return frequencyNeedsTime(this.sched.frequency);
    },

    get needsHour() {
      return frequencyNeedsHour(this.sched.frequency);
    },

    get needsWeekday() {
      return this.sched.frequency === "weekly";
    },

    get visibleJobs() {
      return filterJobs(this.$store.scheduler.jobs, this.filters, (job) => this.identityName(job.botNpub));
    },

    get filtersActive() {
      return Boolean(this.filters.query.trim()) || this.filters.status !== "all" || this.filters.type !== "all";
    },

    get countsText() {
      const c = countJobs(this.$store.scheduler.jobs);
      if (!c.total) return "";
      const parts = [`${c.enabled} enabled`, `${c.disabled} disabled`];
      if (c.unsupported) parts.push(`${c.unsupported} unsupported`);
      return `${c.total} ${c.total === 1 ? "trigger" : "triggers"} · ${parts.join(" · ")}`;
    },

    get resultsText() {
      if (!this.filtersActive) return "";
      const shown = this.visibleJobs.length;
      return `Showing ${shown} of ${this.$store.scheduler.jobs.length}`;
    },

    clearFilters() {
      this.filters = { query: "", status: "all", type: "all" };
    },

    get createSummary() {
      return this.draftSummary(false);
    },

    get editSummary() {
      return this.draftSummary(true);
    },

    draftSummary(edit) {
      const f = edit ? this.editForm : this.form;
      if (!f || f.name === undefined) return "";
      const identity = f.botNpub && this.$store.scheduler.identities.some((i) => i.botNpub === f.botNpub)
        ? this.identityName(f.botNpub) : "";
      return describeDraft({
        actionType: edit ? this.editActionType : this.actionType,
        triggerType: edit ? this.editTriggerType : this.triggerType,
        form: f,
        cronExpression: edit ? this.editComputedCron : this.computedCron,
        identityName: identity,
      });
    },

    // ----- Validation -----

    errors(edit) {
      const f = edit ? this.editForm : this.form;
      const action = edit ? this.editActionType : this.actionType;
      return validateTriggerForm({
        actionType: action,
        triggerType: edit ? this.editTriggerType : this.triggerType,
        form: f,
        identityMessage: this.identityIssue(action, f.botNpub),
      });
    },

    touch(edit, key) {
      this.touchState[edit ? "edit" : "create"].touched[key] = true;
    },

    fieldError(edit, key) {
      const ts = this.touchState[edit ? "edit" : "create"];
      const message = this.errors(edit)[key] || "";
      if (!message) return "";
      return ts.attempted || ts.touched[key] || key === "activeWindow" ? message : "";
    },

    errorSummary(edit) {
      if (!this.touchState[edit ? "edit" : "create"].attempted) return "";
      const keys = Object.keys(this.errors(edit));
      if (!keys.length) return "";
      const names = keys.map((key) => FIELD_LABELS[key] || key).join(", ");
      return `Fix ${keys.length} ${keys.length === 1 ? "problem" : "problems"} before saving: ${names}.`;
    },

    resetTouch(edit) {
      this.touchState[edit ? "edit" : "create"] = { attempted: false, touched: {} };
    },

    /** Mark the form as attempted; returns true when it can be submitted. */
    checkValid(edit) {
      const errors = this.errors(edit);
      if (!Object.keys(errors).length) return true;
      this.touchState[edit ? "edit" : "create"].attempted = true;
      const mode = edit ? "edit" : "create";
      const key = firstInvalidField(errors);
      this.$nextTick(() => {
        const root = this.root;
        const target = key === "botNpub" ? root.querySelector(`#scheduler-${mode}-identity`)
          : key === "activeWindow" ? root.querySelector(`#scheduler-${mode}-activeWindow input`)
            : root.querySelector(`#scheduler-${mode}-${key}`);
        if (target) target.focus();
      });
      return false;
    },

    hasActiveWindow(edit) {
      const f = edit ? this.editForm : this.form;
      return Boolean(f.activeStartTime || f.activeEndTime);
    },

    clearActiveWindow(edit) {
      const f = edit ? this.editForm : this.form;
      f.activeStartTime = "";
      f.activeEndTime = "";
    },

    activeWindowHelp(edit) {
      const f = edit ? this.editForm : this.form;
      if (f.activeStartTime && f.activeEndTime) {
        return `${describeActiveWindow(f.activeStartTime, f.activeEndTime, f.timezone)}. Outside this window the trigger is skipped.`;
      }
      return "Leave empty to run at any time, or set both times to limit when the trigger can fire each day.";
    },

    onActionChange(edit) {
      const isCleanup = (edit ? this.editActionType : this.actionType) === "cleanup";
      if (!isCleanup) return;
      if (edit) this.editTriggerType = "cron";
      else this.triggerType = "cron";
    },

    init() {
      // Handlers run with $el set to the clicked child, so keep the page root for focus lookups.
      this.root = this.$el;
      this.loadPipelineDefinitions();
      // Watch showForm toggle to attach/detach autocomplete on create form
      this.$watch("showForm", (open) => {
        if (open) {
          this.$nextTick(() => this._attachCreateAC());
        } else {
          this._detachAC();
        }
      });
      // Re-attach when trigger type changes (watch dir input appears/disappears)
      this.$watch("triggerType", () => {
        if (this.showForm) {
          this.$nextTick(() => this._attachCreateAC());
        }
      });
      // Watch editingJobId to attach/detach autocomplete on edit form
      this.$watch("editingJobId", (id) => {
        if (id) {
          this.$nextTick(() => this._attachEditAC());
        } else {
          this._detachAC();
        }
      });
      // Re-attach when edit trigger type changes
      this.$watch("editTriggerType", () => {
        if (this.editingJobId) {
          this.$nextTick(() => this._attachEditAC());
        }
      });
    },

    async loadPipelineDefinitions() {
      try {
        const payload = await fetchPipelineDefinitions();
        this.pipelineDefinitions = payload.definitions || [];
      } catch (err) {
        showToast(`Failed to load pipelines: ${err.message}`, { type: "error" });
        this.pipelineDefinitions = [];
      }
    },

    _attachCreateAC() {
      this._detachAC();
      const root = this.root;
      const workDirInput = root.querySelector("[data-ac='create-workdir']");
      const workDirList = root.querySelector("[data-ac='create-workdir-list']");
      if (workDirInput && workDirList) {
        this._acCleanups.push(attachDirAutocomplete(workDirInput, workDirList));
      }
      const watchDirInput = root.querySelector("[data-ac='create-watchdir']");
      const watchDirList = root.querySelector("[data-ac='create-watchdir-list']");
      if (watchDirInput && watchDirList) {
        this._acCleanups.push(attachDirAutocomplete(watchDirInput, watchDirList));
      }
    },

    _attachEditAC() {
      this._detachAC();
      const root = this.root;
      const workDirInput = root.querySelector("[data-ac='edit-workdir']");
      const workDirList = root.querySelector("[data-ac='edit-workdir-list']");
      if (workDirInput && workDirList) {
        this._acCleanups.push(attachDirAutocomplete(workDirInput, workDirList));
      }
      const watchDirInput = root.querySelector("[data-ac='edit-watchdir']");
      const watchDirList = root.querySelector("[data-ac='edit-watchdir-list']");
      if (watchDirInput && watchDirList) {
        this._acCleanups.push(attachDirAutocomplete(watchDirInput, watchDirList));
      }
    },

    _detachAC() {
      this._acCleanups.forEach((fn) => fn());
      this._acCleanups = [];
    },

    get editIsCron() {
      return this.editTriggerType === "cron";
    },

    get editIsPipelineAction() {
      return this.editActionType === "pipeline";
    },

    get editIsSessionAction() {
      return this.editActionType === "session";
    },

    get editIsCleanupAction() {
      return this.editActionType === "cleanup";
    },

    get editIsFileWatcher() {
      return this.editTriggerType === "file_watcher";
    },

    get editComputedCron() {
      return buildCron(this.editSched.frequency, this.editSched.hour, this.editSched.minute, this.editSched.weekday);
    },

    get editCronDescription() {
      return describeCron(this.editComputedCron);
    },

    get editNeedsTime() {
      return frequencyNeedsTime(this.editSched.frequency);
    },

    get editNeedsHour() {
      return frequencyNeedsHour(this.editSched.frequency);
    },

    get editNeedsWeekday() {
      return this.editSched.frequency === "weekly";
    },

    startEdit(job) {
      const resolvedPipelineDefinitionId = this.resolvePipelineDefinitionId(job.pipelineDefinitionId);
      this.editingJobId = job.id;
      this.editActionType = job.actionType || "session";
      this.editTriggerType = job.triggerType || "cron";
      this.editForm = {
        name: job.name,
        botNpub: job.botNpub || "",
        agent: normalizeAgentValue(job.agent || getConfiguredDefaultAgent()),
        model: job.model || formSupport.defaultModel(job.agent),
        workingDirectory: job.workingDirectory,
        initialPrompt: job.initialPrompt,
        pipelineDefinitionId: resolvedPipelineDefinitionId || job.pipelineDefinitionId || "",
        pipelineAgent: job.pipelineAgent || "",
        pipelineInput: this.formatPipelineInput(job.pipelineInputJson),
        timezone: job.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        watchDirectory: job.watchDirectory || "",
        filePattern: job.filePattern || "*",
        activeStartTime: job.activeStartTime || "",
        activeEndTime: job.activeEndTime || "",
      };
      this.syncModel(this.editForm);
      this.editSched = parseCron(job.cronExpression);
      this.resetTouch(true);
      this.cancelPending();
      this.focusWhenReady("#scheduler-edit-name");
    },

    closeEdit() {
      const id = this.editingJobId;
      this.editingJobId = null;
      this.editActionType = "session";
      this.editForm = {};
      this.editSched = {};
      this.focusWhenReady(`[data-edit-btn="${id}"]`);
    },

    cancelEdit() {
      this.closeEdit();
    },

    async saveEdit() {
      if (this.editSubmitting) return;
      if (!this.checkValid(true)) return;
      this.editSubmitting = true;
      try {
        const payload = {
          botNpub: this.editActionType === "cleanup" ? undefined : this.editForm.botNpub,
          name: this.editForm.name,
          actionType: this.editActionType,
          triggerType: this.editTriggerType,
        };
        if (this.editActionType === "pipeline") {
          payload.pipelineDefinitionId = this.editForm.pipelineDefinitionId;
          payload.pipelineInput = this.parsePipelineInput(this.editForm.pipelineInput);
          payload.pipelineAgent = this.editForm.pipelineAgent || null;
          payload.workingDirectory = "";
          payload.initialPrompt = "";
          payload.model = null;
        } else if (this.editActionType === "cleanup") {
          payload.triggerType = "cron";
          payload.agent = "codex";
          payload.workingDirectory = "";
          payload.initialPrompt = "";
          payload.model = null;
          payload.pipelineDefinitionId = null;
          payload.pipelineAgent = null;
          payload.pipelineInput = {};
        } else {
          payload.agent = this.editForm.agent;
          payload.model = this.modelForPayload(this.editForm.model);
          payload.workingDirectory = this.editForm.workingDirectory;
          payload.initialPrompt = this.editForm.initialPrompt;
          payload.pipelineDefinitionId = null;
          payload.pipelineAgent = null;
          payload.pipelineInput = {};
        }
        if (this.editTriggerType === "cron") {
          payload.cronExpression = this.editComputedCron;
          payload.timezone = this.editForm.timezone;
        } else if (this.editTriggerType === "file_watcher") {
          payload.watchDirectory = this.editForm.watchDirectory;
          payload.filePattern = this.editForm.filePattern;
        }
        if (this.editTriggerType === "file_watcher" && this.editForm.activeStartTime && this.editForm.activeEndTime) {
          payload.timezone = this.editForm.timezone;
        }
        // Active window
        if (this.editForm.activeStartTime && this.editForm.activeEndTime) {
          payload.activeStartTime = this.editForm.activeStartTime;
          payload.activeEndTime = this.editForm.activeEndTime;
        } else {
          payload.activeStartTime = null;
          payload.activeEndTime = null;
        }
        await this.$store.scheduler.update(this.editingJobId, payload);
        this.closeEdit();
      } catch { /* store shows toast */ }
      this.editSubmitting = false;
    },

    async refresh() {
      const ok = await this.$store.scheduler.sync();
      if (ok) showToast("Refreshed");
    },

    toggleCreate() {
      if (this.showForm) return this.cancelCreate();
      this.resetTouch(false);
      this.showForm = true;
      this.focusWhenReady("#scheduler-create-name");
    },

    cancelCreate() {
      this.showForm = false;
      this.resetForm();
      this.$nextTick(() => this.root.querySelector("#scheduler-new-trigger")?.focus());
    },

    resetForm() {
      this.actionType = "session";
      this.triggerType = "cron";
      this.form = this.createFormValues();
      this.sched = { ...DEFAULT_SCHEDULE };
      this.resetTouch(false);
      this._detachAC();
    },

    async submitJob() {
      if (this.submitting) return;
      if (!this.checkValid(false)) return;
      this.submitting = true;
      try {
        const payload = {
          botNpub: this.actionType === "cleanup" ? undefined : this.form.botNpub,
          name: this.form.name,
          actionType: this.actionType,
          triggerType: this.triggerType,
        };
        if (this.actionType === "pipeline") {
          payload.pipelineDefinitionId = this.form.pipelineDefinitionId;
          payload.pipelineInput = this.parsePipelineInput(this.form.pipelineInput);
          payload.pipelineAgent = this.form.pipelineAgent || null;
          payload.workingDirectory = "";
          payload.initialPrompt = "";
          payload.model = null;
        } else if (this.actionType === "cleanup") {
          payload.triggerType = "cron";
          payload.agent = "codex";
          payload.workingDirectory = "";
          payload.initialPrompt = "";
          payload.model = null;
          payload.pipelineAgent = null;
        } else {
          payload.agent = this.form.agent;
          payload.model = this.modelForPayload(this.form.model);
          payload.workingDirectory = this.form.workingDirectory;
          payload.initialPrompt = this.form.initialPrompt;
          payload.pipelineAgent = null;
        }
        if (this.triggerType === "cron") {
          payload.cronExpression = this.computedCron;
          payload.timezone = this.form.timezone;
        } else if (this.triggerType === "file_watcher") {
          payload.watchDirectory = this.form.watchDirectory;
          payload.filePattern = this.form.filePattern;
        }
        // Active window (applies to cron and file_watcher)
        if (this.triggerType === "file_watcher" && this.form.activeStartTime && this.form.activeEndTime) {
          payload.timezone = this.form.timezone;
        }
        if (this.form.activeStartTime && this.form.activeEndTime) {
          payload.activeStartTime = this.form.activeStartTime;
          payload.activeEndTime = this.form.activeEndTime;
        }
        await this.$store.scheduler.create(payload);
        this.showForm = false;
        this.resetForm();
        this.$nextTick(() => this.root.querySelector("#scheduler-new-trigger")?.focus());
      } catch { /* store shows toast */ }
      this.submitting = false;
    },


    /** Focus once Alpine has rendered conditional (x-if) markup. */
    focusWhenReady(selector) {
      this.$nextTick(() => requestAnimationFrame(() => this.root.querySelector(selector)?.focus()));
    },

    askConfirm(job, kind) {
      if (kind === "run" && job.triggerType === "unsupported") return;
      this.pending = { id: job.id, kind };
      this.$nextTick(() => this.root.querySelector(`[data-confirm="${job.id}"]`)?.focus());
    },

    cancelPending(job) {
      const id = job?.id || this.pending.id;
      this.pending = { id: null, kind: null };
      if (job) this.$nextTick(() => this.root.querySelector(`[data-job-id="${id}"] .wm-trigger-card-actions button`)?.focus());
    },

    confirmLabel(job) {
      return this.pending.kind === "delete" ? `Confirm delete ${job.name}` : `Confirm run ${job.name}`;
    },

    confirmText(job) {
      return this.pending.kind === "delete"
        ? `Delete "${job.name}"? Its schedule and run history link will be removed. This cannot be undone.`
        : `Run "${job.name}" now? This starts a real run immediately, outside its normal ${job.triggerType === "file_watcher" ? "file trigger" : "schedule"}.`;
    },

    async confirmPending(job) {
      const kind = this.pending.kind;
      this.pending = { id: null, kind: null };
      if (kind === "delete") {
        if (this.runsJobId === job.id) this.closeRuns();
        await this.$store.scheduler.remove(job.id);
        this.$nextTick(() => this.root.querySelector("#scheduler-new-trigger")?.focus());
      } else if (kind === "run") {
        try {
          await this.$store.scheduler.trigger(job.id);
        } catch { /* store shows toast */ }
      }
    },

    async showRuns(job) {
      this.runsJobId = job.id;
      this.runs = [];
      this.runsError = "";
      this.loadingRuns = true;
      try {
        const data = await fetchSchedulerJobRuns(job.id);
        if (this.runsJobId === job.id) this.runs = data.runs || [];
      } catch (err) {
        if (this.runsJobId === job.id) this.runsError = `Couldn't load runs: ${err.message}`;
      }
      this.loadingRuns = false;
    },

    closeRuns(job) {
      const id = job?.id || this.runsJobId;
      this.runsJobId = null;
      this.runs = [];
      this.runsError = "";
      if (job) this.$nextTick(() => this.root.querySelector(`[data-job-id="${id}"] .wm-trigger-card-actions button:nth-child(2)`)?.focus());
    },

    async toggleEnabled(job) {
      if (job.triggerType === "unsupported") return;
      try {
        await this.$store.scheduler.toggleEnabled(job.id, !job.enabled);
      } catch { /* store shows toast */ }
    },

    formatTime(iso) {
      return this.$store.scheduler.formatTime(iso);
    },



    resolvePipelineDefinition(id) {
      if (!id) return null;
      return this.pipelineDefinitions.find((entry) => (
        entry.id === id
        || entry.slug === id
        || entry.name === id
        || entry.path === id
        || entry.supersedes === id
      )) || null;
    },

    resolvePipelineDefinitionId(id) {
      return this.resolvePipelineDefinition(id)?.id || "";
    },

    pipelineName(id) {
      const definition = this.resolvePipelineDefinition(id);
      return definition?.name || id || "Pipeline";
    },


    setPipelineDefaultInput(edit = false) {
      const form = edit ? this.editForm : this.form;
      const definition = this.resolvePipelineDefinition(form.pipelineDefinitionId);
      form.pipelineInput = JSON.stringify(definition?.input || {}, null, 2);
    },

    formatPipelineInput(value) {
      try {
        const parsed = typeof value === "string" && value ? JSON.parse(value) : {};
        return JSON.stringify(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}, null, 2);
      } catch {
        return "{}";
      }
    },

    parsePipelineInput(value) {
      try {
        const parsed = value ? JSON.parse(value) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Pipeline input must be a JSON object");
        }
        return parsed;
      } catch (err) {
        showToast(err.message || "Pipeline input must be valid JSON", { type: "error" });
        throw err;
      }
    },

    async copyToClipboard(text, label) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`${label} copied`);
      } catch {
        showToast("Copy failed", { type: "error" });
      }
    },

  }));

  return { renderPage, ensureLoaded };
}

