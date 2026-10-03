import { evidenceText, portValue, portSelection } from "./viewer-projection.js";
const RECORD_PAGE_SIZE = 50;
export function createViewerValues() {
  let recordSource = null,
    recordRows = [],
    recordTerm = null,
    recordMatches = [];
  const clearRecords = () => {
    recordSource = null;
    recordRows = [];
    recordTerm = null;
    recordMatches = [];
  };
  return {
    clearRecords,
    get inspectedValue() {
      return this.inspectPath
        ? portValue(this.inspector?.value, this.inspectPath)
        : this.inspector?.value;
    },
    get fieldStatus() {
      return this.inspector?.status === "ready" && this.inspectPath
        ? portSelection(this.inspector.value, this.inspectPath).status
        : "present";
    },
    get valueText() {
      return evidenceText(this.inspectedValue);
    },
    get matchingRecords() {
      const values = this.inspectedValue;
      if (!Array.isArray(values)) {
        clearRecords();
        return [];
      }
      if (values !== recordSource) {
        recordSource = values;
        recordRows = values.map((value, index) => ({
          index,
          text: evidenceText(value),
        }));
        recordTerm = null;
      }
      const term = this.search.toLocaleLowerCase();
      if (term !== recordTerm) {
        recordTerm = term;
        recordMatches = term
          ? recordRows.filter((row) =>
              row.text.toLocaleLowerCase().includes(term),
            )
          : recordRows;
      }
      return recordMatches;
    },
    get recordPageCount() {
      return Math.max(
        1,
        Math.ceil(this.matchingRecords.length / RECORD_PAGE_SIZE),
      );
    },
    get currentRecordPage() {
      return Math.min(this.recordPageCount, Math.max(1, this.recordPage));
    },
    get shownRecords() {
      const start = (this.currentRecordPage - 1) * RECORD_PAGE_SIZE;
      return this.matchingRecords.slice(start, start + RECORD_PAGE_SIZE);
    },
    get recordPageSummary() {
      const count = this.matchingRecords.length,
        start = (this.currentRecordPage - 1) * RECORD_PAGE_SIZE;
      return `${count ? start + 1 : 0}–${Math.min(start + RECORD_PAGE_SIZE, count)} of ${count} ${this.search ? "matching" : "loaded"} records · Page ${this.currentRecordPage} of ${this.recordPageCount}`;
    },
    changeRecordPage(page) {
      this.recordPage = Math.min(
        this.recordPageCount,
        Math.max(1, Math.trunc(Number(page)) || 1),
      );
      this.$nextTick?.(() =>
        this.$el
          ?.querySelector(".pipeline-viewer-records")
          ?.scrollIntoView({ block: "nearest" }),
      );
    },
    searchRecords(term) {
      this.search = term;
      this.recordPage = 1;
    },
    get valueMatches() {
      return (
        !this.search ||
        this.valueText
          .toLocaleLowerCase()
          .includes(this.search.toLocaleLowerCase())
      );
    },
    text: evidenceText,
  };
}
