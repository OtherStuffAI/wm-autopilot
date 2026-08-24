/**
 * Directory Autocomplete Utility
 *
 * Lightweight, reusable directory autocomplete for inputs.
 * Uses the same /api/directories endpoint as the main directory browser.
 *
 * Usage:
 *   attachDirAutocomplete(inputEl, datalistEl)
 *   — returns a cleanup function to remove listeners.
 */

const DEBOUNCE_MS = 160;

/** Split user input into a base directory path and partial search term. */
function parseDirectoryLookup(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) return { basePath: "", term: "" };

  if (/[\\/]$/.test(value)) return { basePath: value, term: "" };

  const sep = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (sep === -1) return { basePath: "", term: value };
  return { basePath: value.slice(0, sep + 1), term: value.slice(sep + 1) };
}

/** Fetch directory listing from the server. */
async function fetchDirectories(path, query) {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (query) params.set("query", query);
  const search = params.toString();
  const url = search ? `/api/directories?${search}` : "/api/directories";
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Populate a <datalist> element with directory options. */
function populateDatalist(datalistEl, data) {
  datalistEl.innerHTML = "";
  if (!data) return;
  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const opt = document.createElement("option");
    opt.value = value;
    datalistEl.append(opt);
  };
  if (data.path) add(data.path);
  if (Array.isArray(data.entries)) {
    data.entries.forEach((e) => add(e.path));
  }
}

/**
 * Attach directory autocomplete behaviour to an input + datalist pair.
 *
 * @param {HTMLInputElement} inputEl  — text input
 * @param {HTMLDataListElement} datalistEl — datalist for suggestions
 * @returns {() => void} cleanup function to remove listeners
 */
export function attachDirAutocomplete(inputEl, datalistEl) {
  let timer = null;
  let reqId = 0;

  async function doFetch(value) {
    const id = ++reqId;
    const { basePath, term } = parseDirectoryLookup(value);
    let data = await fetchDirectories(basePath, term);
    if (!data && basePath) {
      data = await fetchDirectories("", term);
    }
    if (reqId !== id) return;
    populateDatalist(datalistEl, data);
  }

  function schedule(value) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => doFetch(value), DEBOUNCE_MS);
  }

  function onInput(e) {
    schedule(e.target.value);
  }
  function onFocus() {
    schedule(inputEl.value);
  }

  inputEl.addEventListener("input", onInput);
  inputEl.addEventListener("focus", onFocus);

  return function cleanup() {
    if (timer) clearTimeout(timer);
    inputEl.removeEventListener("input", onInput);
    inputEl.removeEventListener("focus", onFocus);
  };
}
