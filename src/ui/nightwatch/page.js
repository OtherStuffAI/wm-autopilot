/**
 * Night Watch Page
 *
 * Dedicated page for the timer-based Night Watchman configuration
 * and report cards.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";

export function initNightWatchPage({ showToast }) {
  async function ensureLoaded() {
    const store = Alpine.store("nightwatch");
    if (store) {
      await store.init();
    }
  }

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-nightwatch-page wm-page";
    page.setAttribute("x-data", "nightwatchPage");
    page.innerHTML = getPageTemplate();
    return page;
  }

  Alpine.data("nightwatchPage", () => ({
    async onCyclesChange(event) {
      try {
        const data = await this.$store.nightwatch.updateConfig({
          maxCycles: Number(event.target.value),
        });
        showToast(`Max check-ins set to ${data.maxCycles}`);
      } catch {
        // Store already shows the error toast.
      }
    },

    async refresh() {
      await this.$store.nightwatch.sync();
      showToast("Refreshed");
    },
  }));

  return { renderPage, ensureLoaded };
}

function getPageTemplate() {
  return `
  <div class="wm-nightwatch-header">
    <h2 style="margin: 0;">Night Watchman</h2>
    <button type="button" class="wm-btn wm-btn--sm" @click="refresh()">Refresh</button>
  </div>

  <template x-if="$store.nightwatch.config">
    <div class="wm-nightwatch-config">
      <div class="wm-form-group" style="flex: 1;">
        <label style="font-weight: 600;">Check-in Prompt</label>
        <div style="padding: 0.75rem 0.9rem; border: 1px solid var(--border-color, rgba(255,255,255,0.12)); border-radius: 8px;">
          <span x-text="$store.nightwatch.config.prompt"></span>
        </div>
        <p style="margin: 0.5rem 0 0; opacity: 0.7;">
          Sent automatically every <span x-text="$store.nightwatch.config.intervalMinutes"></span> minutes while Night Watch is enabled.
        </p>
      </div>
      <div class="wm-form-group" style="flex: 0 0 auto;">
        <label style="font-weight: 600;">Max Check-ins</label>
        <select class="wm-select" @change="onCyclesChange($event)">
          <template x-for="c in ($store.nightwatch.config.maxCycleOptions || [6, 21, 256])" :key="c">
            <option :value="String(c)" x-text="String(c)" :selected="c === $store.nightwatch.config.maxCycles"></option>
          </template>
        </select>
      </div>
    </div>
  </template>

  <div class="wm-nightwatch-filters">
    <select class="wm-select" x-model="$store.nightwatch.filterProject">
      <option value="">All Projects</option>
      <template x-for="dir in $store.nightwatch.uniqueProjects" :key="dir">
        <option :value="dir" x-text="$store.nightwatch.extractProject(dir) || dir"></option>
      </template>
    </select>
    <select class="wm-select" x-model="$store.nightwatch.filterStatus">
      <option value="">All Statuses</option>
      <option value="continue">Continue</option>
      <option value="complete">Complete</option>
      <option value="raw">Raw Input</option>
      <option value="monitor">Monitor</option>
      <option value="humanInput">Human Input</option>
    </select>
  </div>

  <div class="wm-nightwatch-report-list">
    <template x-if="$store.nightwatch.loading && $store.nightwatch.reports.length === 0">
      <p style="opacity: 0.6;">Loading reports...</p>
    </template>

    <template x-if="!$store.nightwatch.loading && $store.nightwatch.filteredReports.length === 0">
      <p style="opacity: 0.6;">No report cards match the current filters.</p>
    </template>

    <template x-for="report in $store.nightwatch.filteredReports" :key="report.id">
      <div class="wm-nightwatch-report-card">
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; color: #fff;"
                :style="'background:' + $store.nightwatch.statusColor(report.status)"
                x-text="$store.nightwatch.statusLabel(report.status)"></span>

          <template x-if="report.inputMode === 'raw'">
            <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; color: #fff; background: #8b5cf6; letter-spacing: 0.05em;">RAW</span>
          </template>

          <template x-if="$store.nightwatch.extractProject(report.workingDirectory)">
            <span class="wm-nightwatch-report-card__project"
                  x-text="$store.nightwatch.extractProject(report.workingDirectory)"></span>
          </template>

          <template x-if="report.sessionName">
            <a :href="'/live/' + report.sessionId"
               x-text="report.sessionName"
               style="font-weight: 600; text-decoration: none; color: var(--accent-color, #7dd3fc);"></a>
          </template>
          <template x-if="!report.sessionName">
            <span style="font-weight: 600;" x-text="report.sessionId.slice(0, 8)"></span>
          </template>

          <span style="font-size: 0.75rem; opacity: 0.6; margin-left: auto;"
                x-text="report.cycleCount + ' cycles \\u00b7 ' + $store.nightwatch.formatTime(report.createdAt)"></span>

          <a href="#" style="font-size: 0.65rem; font-weight: 600; color: #8b5cf6; text-decoration: none; opacity: 0.7; margin-left: 0.5rem;"
             @click.prevent="report._showJson = !report._showJson">JSON</a>
        </div>

        <p style="margin: 0; font-size: 0.85rem; line-height: 1.4;" x-text="report.summary"></p>

        <template x-if="report.reasoning">
          <p style="margin: 0.25rem 0 0; font-size: 0.8rem; line-height: 1.3; opacity: 0.7; font-style: italic; border-left: 2px solid rgba(255,255,255,0.15); padding-left: 0.5rem;"
             x-text="report.reasoning"></p>
        </template>

        <template x-if="report._showJson">
          <pre style="margin: 0.5rem 0 0; padding: 0.5rem; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 0.7rem; line-height: 1.3; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto;"
               x-text="JSON.stringify(report, (k, v) => k.startsWith('_') ? undefined : v, 2)"></pre>
        </template>

        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="wm-btn wm-btn--sm"
                  @click="$store.nightwatch.dismiss(report.id)">Dismiss</button>
        </div>
      </div>
    </template>
  </div>
`;
}
