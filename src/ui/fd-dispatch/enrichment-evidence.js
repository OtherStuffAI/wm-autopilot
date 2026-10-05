export function appendEnrichmentEvidence(cell, row) {
  const enrichment = row?.details?.enrichment;
  if (!enrichment) return;
  const status = document.createElement('span');
  status.dataset.testid = 'dispatch-enrichment-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = `Context: ${enrichment.status || 'unknown'}`;
  status.title = enrichment.error || '';
  cell.append(document.createElement('br'), status);
  if (enrichment.runId) {
    const link = document.createElement('a');
    link.href = `/pipelines/runs/${encodeURIComponent(enrichment.runId)}`;
    link.textContent = 'Enrichment run';
    link.dataset.testid = 'dispatch-enrichment-run';
    link.setAttribute('aria-label', `Open enrichment run ${enrichment.runId}`);
    cell.append(document.createElement('br'), link);
  }
}
