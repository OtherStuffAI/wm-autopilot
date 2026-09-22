const request = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
};

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function initSkillsPage({ showToast, openDirectoryBrowser }) {
  const state = { loaded: false, loading: false, sources: [], catalog: [], projects: [], filter: "all", query: "" };

  const load = async () => {
    state.loading = true;
    try {
      const [skills, projects] = await Promise.all([request("/api/skills"), request("/api/npub-projects")]);
      Object.assign(state, skills, { projects: projects.projects ?? [], loaded: true });
    }
    catch (error) { showToast(error.message, { type: "error" }); }
    finally { state.loading = false; }
  };

  const action = async (path, payload) => {
    try { await request(path, { method: "POST", body: JSON.stringify(payload ?? {}) }); await load(); showToast("Skill catalogue updated", { type: "success" }); }
    catch (error) { showToast(error.message, { type: "error" }); }
  };

  const deploy = (skill) => {
    const dialog = element("dialog", "wm-dialog wm-skills__deploy");
    dialog.dataset.testid = "skills-project-selector";
    const form = element("form", "wm-dialog__form"); form.method = "dialog";
    form.innerHTML = `<h3>Apply ${skill.name}</h3><p>Select a known owner-scoped project. Use Browse to register another folder first.</p><label>Project<select aria-label="Deployment project" required><option value="">Select project</option></select></label><label><input type="checkbox" name="claudeCompatibility"> Also copy to .claude/skills</label><label>Repository policy<select name="repositoryPolicy" aria-label="Generated files repository policy"><option value="local_managed">Local managed</option><option value="repository_shared">Repository shared</option></select></label><div class="wm-dialog__actions"><button type="button" class="wm-button secondary" data-register aria-label="Register another project folder">Browse and register</button><button type="button" class="wm-button secondary" data-cancel>Cancel</button><button type="submit" class="wm-button primary" aria-label="Plan and apply skill">Plan and apply</button></div><p aria-live="polite" data-status></p>`;
    const select = form.querySelector("select");
    const fill = () => { select.replaceChildren(new Option("Select project", ""), ...state.projects.map((project) => new Option(`${project.name} — ${project.directoryPath}`, project.id))); };
    fill();
    form.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    form.querySelector("[data-register]").addEventListener("click", async () => {
      const directoryPath = await openDirectoryBrowser?.({ title: "Register Skill Project", confirmLabel: "Register Project", allowCreate: false });
      if (!directoryPath) return;
      try { const result = await request("/api/skills/projects/register", { method: "POST", body: JSON.stringify({ directoryPath }) }); state.projects.unshift(result.project); fill(); select.value = result.project.id; }
      catch (error) { form.querySelector("[data-status]").textContent = error.message; }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const status = form.querySelector("[data-status]"); status.textContent = "Planning…";
      try {
        await request(`/api/skills/projects/${encodeURIComponent(select.value)}/policy`, { method: "PUT", body: JSON.stringify({ claudeCompatibility: form.elements.claudeCompatibility.checked, repositoryPolicy: form.elements.repositoryPolicy.value }) });
        const plan = await request("/api/skills/deployments/plan", { method: "POST", body: JSON.stringify({ action: "apply", projectIds: [select.value], skillIds: [skill.skillId] }) });
        const unsafe = plan.operations.find((operation) => ["conflict", "locally_modified", "error"].includes(operation.state));
        if (unsafe) { status.textContent = `${unsafe.state}: ${unsafe.reason}. Inspect or explicitly resolve this deployment.`; return; }
        const result = await request("/api/skills/deployments/apply", { method: "POST", body: JSON.stringify({ planToken: plan.token }) });
        const failure = result.results.find((entry) => !entry.ok); if (failure) throw new Error(failure.error);
        dialog.close(); dialog.remove(); await load(); rerender(); showToast(`${skill.name} deployed`, { type: "success" });
      } catch (error) { status.textContent = error.message; }
    });
    dialog.append(form); document.body.append(dialog); dialog.showModal();
  };

  const mutateDeployment = async (skill, deployment, actionName) => {
    try {
      const plan = await request("/api/skills/deployments/plan", { method: "POST", body: JSON.stringify({ action: actionName, projectIds: [deployment.projectId], skillIds: [skill.skillId] }) });
      const unsafe = actionName === "remove" && plan.operations.some((operation) => operation.state === "locally_modified");
      if (unsafe) throw new Error("Locally modified content cannot be removed. Detach it or inspect the files.");
      const result = await request(`/api/skills/deployments/${actionName}`, { method: "POST", body: JSON.stringify({ planToken: plan.token }) });
      const failure = result.results.find((entry) => !entry.ok); if (failure) throw new Error(failure.error);
      await load(); rerender(); showToast(`Deployment ${actionName} complete`, { type: "success" });
    } catch (error) { showToast(error.message, { type: "error" }); }
  };

  const renderSourceForm = () => {
    const form = element("form", "wm-skills__source-form");
    form.dataset.testid = "skills-source-form";
    form.innerHTML = `<label>Name<input name="name" required aria-label="Source name"></label><label>Class<select name="sourceClass" aria-label="Source class"><option value="user">User</option><option value="third_party">Third-party</option><option value="wingman">Wingman</option></select></label><label>Kind<select name="sourceKind" aria-label="Source kind"><option value="git">Git / Forgejo</option><option value="local">Local folder</option></select></label><label>URL or folder<div class="wm-skills__path"><input name="location" required aria-label="Source URL or folder"><button type="button" class="wm-button secondary" data-browse aria-label="Browse for local skill source">Browse…</button></div></label><label>Branch or tag<input name="ref" aria-label="Branch or tag"></label><button class="wm-button primary" type="submit" aria-label="Register skill source">Register source</button>`;
    form.querySelector("[data-browse]").addEventListener("click", async () => {
      const selected = await openDirectoryBrowser?.();
      if (selected) form.elements.location.value = selected;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      try { await request("/api/skills/sources", { method: "POST", body: JSON.stringify(values) }); form.reset(); await load(); showToast("Source registered", { type: "success" }); }
      catch (error) { showToast(error.message, { type: "error" }); }
    });
    return form;
  };

  const render = () => {
    const main = element("section", "wm-skills");
    main.dataset.testid = "skills-page";
    main.setAttribute("aria-labelledby", "skills-heading");
    const header = element("header", "wm-skills__header");
    header.innerHTML = `<div><p class="wm-eyebrow">Runtime catalogue</p><h2 id="skills-heading">Skills</h2><p>Import immutable Agent Skill revisions and safely deploy managed copies to projects.</p></div>`;
    const refresh = element("button", "wm-button secondary", state.loading ? "Refreshing…" : "Refresh");
    refresh.type = "button"; refresh.dataset.testid = "skills-refresh"; refresh.setAttribute("aria-label", "Refresh skill catalogue"); refresh.addEventListener("click", load);
    header.append(refresh); main.append(header);
    const status = element("p", "wm-skills__status", state.loading ? "Loading skill catalogue…" : `${state.catalog.length} skills from ${state.sources.length} sources`);
    status.setAttribute("aria-live", "polite"); main.append(status);
    main.append(renderSourceForm());
    const controls = element("div", "wm-skills__controls");
    controls.innerHTML = `<input type="search" placeholder="Search skills" aria-label="Search skills" data-testid="skills-search"><select aria-label="Filter skills by source class" data-testid="skills-filter"><option value="all">All sources</option><option value="wingman">Wingman</option><option value="third_party">Third-party</option><option value="user">User</option></select>`;
    controls.querySelector("input").value = state.query; controls.querySelector("select").value = state.filter;
    controls.querySelector("input").addEventListener("input", (event) => { state.query = event.target.value.toLowerCase(); rerender(); });
    controls.querySelector("select").addEventListener("change", (event) => { state.filter = event.target.value; rerender(); });
    main.append(controls);
    const sources = element("section", "wm-skills__sources"); sources.innerHTML = "<h3>Sources</h3>";
    for (const source of state.sources) {
      const card = element("article", "wm-card wm-skills__source");
      card.innerHTML = `<div><strong></strong><span class="wm-skill-badge"></span><p></p></div><div class="wm-skills__actions"></div>`;
      card.querySelector("strong").textContent = source.name; card.querySelector("span").textContent = source.sourceClass.replace("_", "-"); card.querySelector("p").textContent = `${source.sourceKind}: ${source.location}`;
      const actions = card.querySelector(".wm-skills__actions");
      for (const [label, endpoint] of [["Fetch", "fetch"], ["Import", "import"]]) {
        const button = element("button", "wm-button secondary", label); button.type = "button"; button.setAttribute("aria-label", `${label} ${source.name}`);
        button.addEventListener("click", async () => {
          if (endpoint === "fetch") return action(`/api/skills/sources/${encodeURIComponent(source.id)}/fetch`);
          try {
            const imported = await request(`/api/skills/sources/${encodeURIComponent(source.id)}/import`, { method: "POST", body: "{}" });
            if (!imported.imported) throw new Error(imported.revisions?.flatMap((revision) => revision.errors).join(" · ") || "Import validation failed");
            await request(`/api/skills/sources/${encodeURIComponent(source.id)}/activate`, { method: "POST", body: JSON.stringify({ importId: imported.importId }) });
            await load(); rerender(); showToast("Revision imported and activated; projects were not changed", { type: "success" });
          } catch (error) { showToast(error.message, { type: "error" }); }
        }); actions.append(button);
      }
      sources.append(card);
    }
    main.append(sources);
    const list = element("section", "wm-skills__catalog"); list.innerHTML = "<h3>Catalogue</h3>";
    const visible = state.catalog.filter((skill) => (state.filter === "all" || skill.source?.sourceClass === state.filter) && `${skill.name} ${skill.description}`.toLowerCase().includes(state.query));
    for (const skill of visible) {
      const card = element("article", "wm-card wm-skill-card"); card.dataset.testid = `skill-card-${skill.name}`;
      card.innerHTML = `<header><div><h4></h4><p></p></div><span class="wm-skill-badge"></span></header><dl><div><dt>Revision</dt><dd></dd></div><div><dt>Compatibility</dt><dd></dd></div><div><dt>Deployments</dt><dd></dd></div></dl><details><summary>Revision files and validation</summary><p class="wm-skill-warning"></p><ul></ul></details><details data-deployments><summary>Deployment status and actions</summary><div></div></details>`;
      card.querySelector("h4").textContent = skill.name; card.querySelector("header p").textContent = skill.description || "No description"; card.querySelector(".wm-skill-badge").textContent = skill.source?.sourceClass ?? "unknown";
      const values = card.querySelectorAll("dd"); values[0].textContent = skill.contentDigest.slice(0, 12); values[1].textContent = skill.compatibility.join(", "); values[2].textContent = String(skill.deployments.length);
      card.querySelector(".wm-skill-warning").textContent = [...skill.warnings, ...skill.errors].join(" · ") || "Validation passed";
      for (const file of skill.files) card.querySelector("ul").append(element("li", "", file));
      const deploymentList = card.querySelector("[data-deployments] div");
      for (const deployment of skill.deployments) {
        const row = element("div", "wm-skills__deployment");
        row.append(element("span", "", `${deployment.targetDirectory} · ${deployment.state} · ${deployment.revisionId.slice(0, 8)} · ${deployment.updatedAt}`));
        for (const actionName of ["update", "remove", "detach"]) { const button = element("button", "wm-button secondary", actionName); button.type = "button"; button.setAttribute("aria-label", `${actionName} ${skill.name} in ${deployment.targetDirectory}`); button.addEventListener("click", () => mutateDeployment(skill, deployment, actionName)); row.append(button); }
        deploymentList.append(row);
      }
      const manage = element("button", "wm-button primary", "Apply to project"); manage.type = "button"; manage.setAttribute("aria-label", `Apply ${skill.name} to project`); manage.addEventListener("click", () => deploy(skill)); card.append(manage);
      list.append(card);
    }
    if (!visible.length) list.append(element("p", "wm-empty-state", "No skills match this view."));
    main.append(list); return main;
  };
  let host = null;
  const rerender = () => { if (host) host.replaceChildren(render()); };
  return { ensureLoaded: load, renderPage() { host = element("div", "wm-skills-host"); host.append(render()); if (!state.loaded && !state.loading) void load().then(rerender); return host; } };
}
