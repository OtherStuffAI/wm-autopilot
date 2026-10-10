import { button, element, field, input, select } from "./controls.js";

/** Draft form only; inventory and resulting authority are Dexie-backed metadata. */
export function createHostedSiteGrantEditor({ record, inventory, workspaceId, onSave, onCancel }) {
  const form = element("form"); form.setAttribute("aria-label", "Authorize hosted signup"); form.dataset.testid = "hosted-site-grant-form";
  form.append(element("h2", "Authorize hosted signup"), element("p", "This app may attest verified signup requests for one exact hosted Tower endpoint. The signing key stays in Autopilot custody."),
    element("p", `Site identity: ${record.publicNpub} · Secret revision: ${record.revision}`));
  const apps = inventory.apps || [];
  const app = select([["", "Choose a managed app"], ...apps.map(row => [row.id, `${row.label} (${row.id})`])], ""); app.required = true;
  const root = element("p"); root.dataset.testid = "hosted-site-app-root"; root.setAttribute("aria-live", "polite");
  app.addEventListener("change", () => { root.textContent = `Bound app root: ${apps.find(row => row.id === app.value)?.root || "Choose an app"}`; });
  const url = input("url"); url.required = true; url.placeholder = "https://hosted.example/api/v4/flightdeck-pg/hosted/workspaces";
  const days = input("number", "30"); days.min = "1"; days.max = "90"; days.required = true;
  const consent = input("checkbox"); consent.required = true;
  const status = element("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.dataset.testid = "hosted-site-grant-status";
  const save = button("Authorize app for hosted signup", () => form.requestSubmit(), "hosted-site-grant-save");
  save.disabled = !apps.length;
  if (!apps.length) status.textContent = "No managed apps owned by this user are available.";
  form.append(field("Managed app", app, "hosted-site-grant-app"), root,
    field("Exact HTTPS hosted signup URL", url, "hosted-site-grant-url"), field("Expires in days", days, "hosted-site-grant-days"),
    field("Allow this app to attest verified signups for this endpoint", consent, "hosted-site-grant-consent"),
    save, button("Cancel hosted signup authorization", onCancel, "hosted-site-grant-cancel"), status);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity() || save.disabled) return;
    try {
      const target = new URL(url.value);
      if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash
        || target.pathname !== "/api/v4/flightdeck-pg/hosted/workspaces" || target.href !== url.value) throw new Error("Enter the exact HTTPS hosted signup endpoint.");
      const duration = Number(days.value);
      if (!Number.isInteger(duration) || duration < 1 || duration > 90) throw new Error("Expiry must be between 1 and 90 days.");
      save.disabled = true; form.setAttribute("aria-busy", "true"); status.textContent = "Authorizing app…";
      await onSave({ workspaceId, appId: app.value, secretId: record.id, secretRevision: record.revision, siteNpub: record.publicNpub,
        url: target.href, expiresAt: Math.floor(Date.now() / 1000) + duration * 86400 });
    } catch (error) { status.textContent = error.message || "Hosted signup authorization failed."; }
    finally { save.disabled = !apps.length; form.setAttribute("aria-busy", "false"); }
  });
  return form;
}
