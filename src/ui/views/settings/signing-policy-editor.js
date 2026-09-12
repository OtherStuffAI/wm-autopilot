import { element, disclosure } from "./signing-policy-presentation.js";
import { summaryList } from "./signing-policy-details.js";
import { saveSigningPolicy } from "../../services/signing-policies.js";

function parseReplacementDraft(text, expectedId) {
  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON. Paste one complete policy object.');
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('Replacement must be one JSON policy object.');
  }
  if (draft.id !== expectedId) {
    throw new Error(`Replacement ID must stay ${expectedId}. Create a new policy for a different ID.`);
  }
  return draft;
}

export function createPolicyEditor(policy, { status, refresh, draftFromPolicy }) {
    const section = disclosure('Advanced: restrictions and policy JSON', 'signing-policy-editor');
    section.append(element('p', policy.builtIn === 'baseline' ? 'This is the starting permission set for every session. Enabled assigned policies can add permissions.' : 'This policy adds permissions to the built-in baseline and other assigned policies. Event tags constrain signed content; they do not control where it is published.'));
    if (!policy.nip98Targets?.length) section.append(element('p', 'No HTTP destinations granted by this policy.'));
    section.append(summaryList(policy));
    if (policy.editable === false || policy.builtIn === 'baseline') {
      section.append(element('pre', JSON.stringify(policy, null, 2)));
      return { section, edit: null };
    }
    const current = element('pre', JSON.stringify(draftFromPolicy(policy), null, 2));
    current.dataset.testid = 'signing-policy-current-json';
    const edit = element('button', 'Edit / replace JSON', 'wm-button secondary');
    edit.type = 'button';
    edit.dataset.testid = 'signing-policy-edit-json';
    edit.setAttribute('aria-label', `Edit or replace JSON for ${policy.name}`);
    const label = element('label');
    label.append(element('span', 'Advanced structured policy JSON'));
    const textarea = element('textarea');
    textarea.rows = 22;
    textarea.value = JSON.stringify(draftFromPolicy(policy), null, 2);
    textarea.dataset.testid = 'signing-policy-json';
    textarea.setAttribute('aria-label', `Structured JSON for ${policy.name}`);
    label.append(textarea);
    const review = element('button', 'Review replacement', 'wm-button secondary');
    review.type = 'button';
    review.dataset.testid = 'signing-policy-review-json';
    review.setAttribute('aria-label', 'Review replacement policy JSON');
    const save = element('button', 'Save replacement', 'wm-button primary');
    save.type = 'button';
    save.setAttribute('aria-label', 'Save reviewed replacement policy JSON');
    save.dataset.testid = 'signing-policy-save';
    save.disabled = true;
    const cancel = element('button', 'Cancel', 'wm-button secondary');
    cancel.type = 'button';
    cancel.dataset.testid = 'signing-policy-cancel-json';
    cancel.setAttribute('aria-label', 'Cancel policy JSON replacement');
    const preview = element('pre');
    preview.hidden = true;
    preview.dataset.testid = 'signing-policy-review-preview';
    let reviewedText = '';
    const editor = element('div');
    editor.hidden = true;
    function resetEditor() {
      textarea.value = JSON.stringify(draftFromPolicy(policy), null, 2);
      reviewedText = '';
      save.disabled = true;
      preview.hidden = true;
      preview.textContent = '';
    }
    function openEditor() {
      section.open = true;
      editor.hidden = false;
      edit.hidden = true;
      resetEditor();
      textarea.focus?.();
    }
    function closeEditor() {
      editor.hidden = true;
      edit.hidden = false;
      resetEditor();
      status.textContent = `${policy.name} replacement cancelled.`;
      status.dataset.state = 'ready';
    }
    textarea.addEventListener('input', () => {
      reviewedText = '';
      save.disabled = true;
      preview.hidden = true;
      preview.textContent = '';
      status.textContent = 'Review the replacement JSON before saving.';
      status.dataset.state = 'ready';
    });
    edit.addEventListener('click', openEditor);
    cancel.addEventListener('click', closeEditor);
    review.addEventListener('click', () => {
      try {
        const draft = parseReplacementDraft(textarea.value, policy.id);
        preview.textContent = JSON.stringify(draft, null, 2);
        preview.hidden = false;
        reviewedText = preview.textContent;
        save.disabled = false;
        status.textContent = `Review the replacement below. Policy will be ${draft.enabled ? 'enabled' : 'disabled'}. Server validation runs when saving.`;
        status.dataset.state = 'ready';
      } catch (error) {
        reviewedText = '';
        save.disabled = true;
        preview.hidden = true;
        preview.textContent = '';
        status.textContent = error instanceof Error ? error.message : 'Replacement review failed.';
        status.dataset.state = 'error';
      }
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      review.disabled = true;
      cancel.disabled = true;
      status.textContent = `Saving ${policy.name}…`;
      status.dataset.state = 'loading';
      try {
        const draft = parseReplacementDraft(textarea.value, policy.id);
        if (JSON.stringify(draft, null, 2) !== reviewedText) throw new Error('Replacement changed. Review it again before saving.');
        await saveSigningPolicy(policy.id, draft);
        await refresh(policy.id, `${policy.name} saved as a replacement revision. Existing issued session permissions were not changed.`);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Policy save failed.';
        status.dataset.state = 'error';
        save.disabled = false;
        review.disabled = false;
        cancel.disabled = false;
      }
    });
    const actions = element('div', undefined, 'wm-settings-page__actions');
    actions.append(review, save, cancel);
    editor.append(label, actions, preview);
    section.append(current, editor);
    return { section, edit };
  }

