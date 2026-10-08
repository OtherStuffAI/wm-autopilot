/** Identity selection never substitutes an unavailable saved signer. */
export function identityIssue(action, botNpub, identities, status) {
  if (action === "cleanup") return "";
  if (status !== "ready") return status === "loading" ? "Loading Run as identities…" : "Run as identities could not be loaded. Retry before saving.";
  if (!identities.length && !botNpub) return "No owned active identities are available. Create an identity before saving.";
  if (!botNpub) return "Choose a Run as identity.";
  if (!identities.some((identity) => identity.botNpub === botNpub)) return "Saved identity is unavailable. Choose an owned active identity to save.";
  return "";
}

export function identityName(botNpub, identities, status) {
  if (!botNpub) return "Identity missing";
  const identity = identities.find((entry) => entry.botNpub === botNpub);
  if (status !== "ready") return identity ? `${identity.name} (identity unverified)` : "Identity unverified";
  return identity?.name || "Unavailable identity";
}

export function runIdentityField(edit = false) {
  const form = edit ? "editForm" : "form";
  const action = edit ? "editActionType" : "actionType";
  const id = edit ? "edit" : "create";
  return `<div class="wm-form-group" x-show="${action} !== 'cleanup'">
    <label for="scheduler-${id}-identity">Run as identity</label>
    <select id="scheduler-${id}-identity" class="wm-select" x-model="${form}.botNpub"
      aria-label="Run as identity" data-testid="scheduler-${id}-identity" :disabled="$store.scheduler.identityStatus !== 'ready'">
      <option value="">Choose an identity…</option>
      <template x-if="${form}.botNpub && !$store.scheduler.identities.some(i => i.botNpub === ${form}.botNpub)">
        <option :value="${form}.botNpub" x-text="'Unavailable: ' + ${form}.botNpub" disabled></option>
      </template>
      <template x-for="identity in $store.scheduler.identities" :key="identity.botNpub">
        <option :value="identity.botNpub" x-text="identity.name + ' — ' + identity.botNpub"></option>
      </template>
    </select>
    <code x-text="${form}.botNpub" style="display:block; overflow-wrap:anywhere; user-select:text" data-testid="scheduler-${id}-identity-npub"></code>
    <p role="status" aria-live="polite" x-text="identityIssue(${action}, ${form}.botNpub)" data-testid="scheduler-${id}-identity-status"></p>
    <button x-show="$store.scheduler.identityStatus === 'error'" type="button" class="wm-btn wm-btn--sm" @click="$store.scheduler.syncIdentities()"
      aria-label="Reload Run as identities" data-testid="scheduler-${id}-identity-retry">Reload identities</button>
  </div>`;
}
