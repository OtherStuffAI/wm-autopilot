import { createCatalogueSection, createSourcesSection, element } from "./page-components.js";

const request = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
};

export function initSkillsPage({ showToast, openDirectoryBrowser }) {
  const state = { loaded: false, loading: false, sources: [], catalog: [], projects: [], filter: "all", query: "", busySource: null, message: "" };
  let host = null;
  const rerender = () => { if (host) host.replaceChildren(render()); };

  const load = async () => {
    state.loading = true; state.message = state.loaded ? "Refreshing catalogue…" : "Loading skill catalogue…"; rerender();
    try {
      const [skills, projects] = await Promise.all([request("/api/skills"), request("/api/npub-projects")]);
      Object.assign(state, skills, { projects: projects.projects ?? [], loaded: true, message: "" });
    } catch (error) { state.message = `Could not load the catalogue: ${error.message}`; showToast(error.message, { type: "error" }); }
    finally { state.loading = false; rerender(); }
  };

  const importExisting = async (source) => {
    state.busySource = source.id; state.message = `Importing ${source.name}…`; rerender();
    try {
      const imported = await request(`/api/skills/sources/${encodeURIComponent(source.id)}/import`, { method: "POST", body: "{}" });
      if (!imported.imported) throw new Error(imported.revisions?.flatMap((revision) => revision.errors).join(" · ") || "Import validation failed");
      await request(`/api/skills/sources/${encodeURIComponent(source.id)}/activate`, { method: "POST", body: JSON.stringify({ importId: imported.importId }) });
      await load(); state.message = `${source.name} imported and activated. Projects were not changed.`; showToast(`${source.name} imported`, { type: "success" });
    } catch (error) { state.message = `${source.name} was not imported: ${error.message}`; showToast(error.message, { type: "error" }); }
    finally { state.busySource = null; rerender(); }
  };

  const openSourceDialog = () => {
    const dialog = element("dialog", "wm-skills-dialog"); dialog.dataset.testid = "skills-source-dialog";
    dialog.innerHTML = `<form class="wm-skills-dialog__panel" data-testid="skills-source-form"><header><div><p class="wm-eyebrow">Catalogue source</p><h2>Add and import source</h2><p>Import a Git repository or an allowed local folder. Nothing is deployed to projects.</p></div><button type="button" class="wm-icon-button" data-close aria-label="Close add source dialog">×</button></header><div class="wm-skills-dialog__body"><label><span>Source name</span><input name="name" required autocomplete="off" placeholder="For example, Brag" data-testid="skills-source-name"></label><div class="wm-skills-dialog__row"><label><span>Ownership</span><select name="sourceClass" aria-label="Source ownership"><option value="third_party">Third-party</option><option value="user">Personal</option><option value="wingman">Wingman managed</option></select></label><label><span>Source type</span><select name="sourceKind" aria-label="Source type"><option value="git">Git repository</option><option value="local">Local folder</option></select></label></div><label><span data-location-label>Repository URL</span><div class="wm-skills-dialog__path"><input name="location" required autocomplete="off" placeholder="https://github.com/owner/repository.git" data-testid="skills-source-location"><button type="button" class="wm-button secondary" data-browse aria-label="Browse for local skill source">Browse…</button></div></label><label data-ref><span>Branch or tag <small>(optional)</small></span><input name="ref" autocomplete="off" placeholder="Uses the repository default"></label><p class="wm-skills-dialog__note">The resolved revision is validated and stored as an immutable snapshot. Compatibility aliases are never copied.</p><p class="wm-skills-dialog__status" aria-live="polite" data-status></p></div><footer><button type="button" class="wm-button secondary" data-cancel>Cancel</button><button type="submit" class="wm-button primary" data-testid="skills-import-source">Import source</button></footer></form>`;
    const form = dialog.querySelector("form"); const kind = form.elements.sourceKind;
    const syncKind = () => { const local = kind.value === "local"; form.querySelector("[data-location-label]").textContent = local ? "Folder" : "Repository URL"; form.elements.location.placeholder = local ? "/path/to/skills" : "https://github.com/owner/repository.git"; form.querySelector("[data-browse]").hidden = !local; form.querySelector("[data-ref]").hidden = local; };
    kind.addEventListener("change", syncKind); syncKind();
    const close = () => { dialog.close(); dialog.remove(); }; form.querySelector("[data-close]").addEventListener("click", close); form.querySelector("[data-cancel]").addEventListener("click", close);
    form.querySelector("[data-browse]").addEventListener("click", async () => { const selected = await openDirectoryBrowser?.({ title: "Choose Skill Source", confirmLabel: "Use Folder", allowCreate: false }); if (selected) form.elements.location.value = selected; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const status = form.querySelector("[data-status]"); const submit = form.querySelector("[type=submit]"); status.textContent = "Fetching, validating, and importing…"; submit.disabled = true;
      try { const values = Object.fromEntries(new FormData(form)); await request("/api/skills/sources/import", { method: "POST", body: JSON.stringify(values) }); close(); await load(); state.message = `${values.name} imported and activated. Projects were not changed.`; rerender(); showToast(`${values.name} imported`, { type: "success" }); }
      catch (error) { status.textContent = error.message; submit.disabled = false; }
    });
    document.body.append(dialog); dialog.showModal(); form.elements.name.focus();
  };

  const deploy = (skill) => {
    const dialog = element("dialog", "wm-skills-dialog"); dialog.dataset.testid = "skills-project-selector";
    dialog.innerHTML = `<form class="wm-skills-dialog__panel"><header><div><p class="wm-eyebrow">Project deployment</p><h2>Apply ${skill.name}</h2><p>Choose where Autopilot should maintain this skill.</p></div><button type="button" class="wm-icon-button" data-close aria-label="Close project deployment dialog">×</button></header><div class="wm-skills-dialog__body"><label><span>Project</span><select name="project" aria-label="Deployment project" required><option value="">Select a project</option></select></label><button type="button" class="wm-button secondary wm-skills-dialog__browse" data-register>Browse and register another project</button><label class="wm-check"><input type="checkbox" name="claudeCompatibility"><span>Also maintain a compatibility copy in <code>.claude/skills</code></span></label><label><span>How should Git treat managed files?</span><select name="repositoryPolicy" aria-label="Managed files Git policy"><option value="local_managed">Keep managed files local</option><option value="repository_shared">Include managed files in the repository</option></select></label><p class="wm-skills-dialog__status" aria-live="polite" data-status></p></div><footer><button type="button" class="wm-button secondary" data-cancel>Cancel</button><button type="submit" class="wm-button primary">Review and apply</button></footer></form>`;
    const form = dialog.querySelector("form"); const select = form.elements.project; const fill = () => { select.replaceChildren(new Option("Select a project", ""), ...state.projects.map((project) => new Option(`${project.name} — ${project.directoryPath}`, project.id))); }; fill();
    const close = () => { dialog.close(); dialog.remove(); }; form.querySelector("[data-close]").addEventListener("click", close); form.querySelector("[data-cancel]").addEventListener("click", close);
    form.querySelector("[data-register]").addEventListener("click", async () => { const directoryPath = await openDirectoryBrowser?.({ title: "Register Skill Project", confirmLabel: "Register Project", allowCreate: false }); if (!directoryPath) return; try { const result = await request("/api/skills/projects/register", { method: "POST", body: JSON.stringify({ directoryPath }) }); state.projects.unshift(result.project); fill(); select.value = result.project.id; } catch (error) { form.querySelector("[data-status]").textContent = error.message; } });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const status = form.querySelector("[data-status]"); status.textContent = "Checking the project…";
      try { await request(`/api/skills/projects/${encodeURIComponent(select.value)}/policy`, { method: "PUT", body: JSON.stringify({ claudeCompatibility: form.elements.claudeCompatibility.checked, repositoryPolicy: form.elements.repositoryPolicy.value }) }); const plan = await request("/api/skills/deployments/plan", { method: "POST", body: JSON.stringify({ action: "apply", projectIds: [select.value], skillIds: [skill.skillId] }) }); const unsafe = plan.operations.find((operation) => ["conflict", "locally_modified", "error"].includes(operation.state)); if (unsafe) { status.textContent = `${unsafe.reason}. Existing files were not changed.`; return; } const result = await request("/api/skills/deployments/apply", { method: "POST", body: JSON.stringify({ planToken: plan.token }) }); const failure = result.results.find((entry) => !entry.ok); if (failure) throw new Error(failure.error); close(); await load(); showToast(`${skill.name} applied to project`, { type: "success" }); }
      catch (error) { status.textContent = error.message; }
    }); document.body.append(dialog); dialog.showModal();
  };

  const mutateDeployment = async (skill, deployment, actionName) => {
    try { const plan = await request("/api/skills/deployments/plan", { method: "POST", body: JSON.stringify({ action: actionName, projectIds: [deployment.projectId], skillIds: [skill.skillId] }) }); if (actionName === "remove" && plan.operations.some((operation) => operation.state === "locally_modified")) throw new Error("Locally modified files cannot be removed. Detach them to keep the files without Autopilot management."); const result = await request(`/api/skills/deployments/${actionName}`, { method: "POST", body: JSON.stringify({ planToken: plan.token }) }); const failure = result.results.find((entry) => !entry.ok); if (failure) throw new Error(failure.error); await load(); showToast(`Deployment ${actionName} complete`, { type: "success" }); }
    catch (error) { state.message = error.message; rerender(); showToast(error.message, { type: "error" }); }
  };

  const render = () => {
    const main = element("main", "wm-skills"); main.dataset.testid = "skills-page"; main.setAttribute("aria-labelledby", "skills-heading");
    const header = element("header", "wm-skills__hero"); header.innerHTML = `<div><p class="wm-eyebrow">Runtime catalogue</p><h1 id="skills-heading">Skills</h1><p>Bring trusted Agent Skills into one catalogue, then apply managed copies to your projects.</p></div><div class="wm-skills__hero-actions"><button type="button" class="wm-button secondary" data-refresh data-testid="skills-refresh">${state.loading ? "Refreshing…" : "Refresh"}</button><button type="button" class="wm-button primary" data-add data-testid="skills-add-source">Add source</button></div>`; header.querySelector("[data-refresh]").addEventListener("click", load); header.querySelector("[data-add]").addEventListener("click", openSourceDialog); main.append(header);
    const summary = element("section", "wm-skills__summary"); summary.setAttribute("aria-label", "Catalogue summary"); summary.innerHTML = `<div><strong>${state.catalog.length}</strong><span>Available skills</span></div><div><strong>${state.sources.length}</strong><span>Sources</span></div><div><strong>${state.catalog.reduce((count, skill) => count + skill.deployments.length, 0)}</strong><span>Project installs</span></div>`; main.append(summary);
    const status = element("p", "wm-skills__status", state.message); status.dataset.testid = "skills-status"; status.setAttribute("aria-live", "polite"); main.append(status);
    if (!state.loaded && state.loading) { const loading = element("section", "wm-card wm-skills__empty", "Loading your skill catalogue…"); loading.dataset.testid = "skills-loading"; main.append(loading); return main; }
    main.append(createSourcesSection(state, importExisting, openSourceDialog)); main.append(createCatalogueSection(state, { deploy, mutateDeployment, onQuery(query) { state.query = query; rerender(); }, onFilter(filter) { state.filter = filter; rerender(); }, openSourceDialog })); return main;
  };
  return { ensureLoaded: load, renderPage() { host = element("div", "wm-skills-host"); host.append(render()); if (!state.loaded && !state.loading) void load(); return host; } };
}
