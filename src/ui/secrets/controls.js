export function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function button(label, action, id) {
  const node = element("button", label, "wm-button secondary");
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.dataset.testid = id;
  node.addEventListener("click", action);
  return node;
}
export function field(label, input, id) {
  const wrapper = element("label", "", "wm-secret-field");
  input.setAttribute("aria-label", label);
  input.dataset.testid = id;
  wrapper.append(element("span", label), input);
  return wrapper;
}
export function input(type = "text", value = "") {
  const node = element("input"); node.type = type; node.value = value; return node;
}
export function select(options, value) {
  const node = element("select");
  for (const [id, label] of options) { const option = element("option", label); option.value = id; node.append(option); }
  node.value = value; return node;
}
export function choices(label, records, selected, key, id) {
  const group = element("fieldset"); group.append(element("legend", label));
  const controls = new Map();
  // Retain configured identities/references that disappeared from the discovery inventory.
  const rows = new Map(records.map(row => [row[key], row.label || row[key]]));
  for (const value of selected) if (!rows.has(value)) rows.set(value, `${value} (configured)`);
  for (const [value, name] of rows) {
    const control = input("checkbox"); control.checked = selected.includes(value);
    controls.set(value, control);
    group.append(field(name, control, `${id}-${value}`));
  }
  return { node: group, values: () => [...controls].filter(([, control]) => control.checked).map(([value]) => value) };
}
export function contextControl(label, records, policy, key, id) {
  const node = element("fieldset"); node.append(element("legend", label));
  const enabled = input("checkbox"); enabled.checked = policy?.enabled === true;
  const mode = select([["all", "All"], ["selected", "Selected only"]], policy?.mode || "selected");
  const selected = choices("Allowed consumers", records, policy?.ids || [], key, id);
  const additional = element("textarea"); additional.rows = 2;
  const manual = field(label === "Pipelines" ? "Additional pipeline IDs (one per line)" : "Additional agent npubs (one per line)", additional, `${id}-additional`);
  function update() { mode.disabled = !enabled.checked; selected.node.hidden = !enabled.checked || mode.value !== "selected"; manual.hidden = selected.node.hidden; }
  enabled.addEventListener("change", update); mode.addEventListener("change", update); update();
  node.append(field(`Enable ${label.toLowerCase()}`, enabled, `${id}-enabled`), field(`${label} scope`, mode, `${id}-mode`), selected.node, manual);
  return { node, value: () => ({ enabled: enabled.checked, mode: mode.value,
    ids: mode.value === "selected" ? [...new Set([...selected.values(), ...additional.value.split(/\s+/).filter(Boolean)])] : [] }) };
}
