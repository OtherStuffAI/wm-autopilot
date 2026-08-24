import { decodeBase64ToUint8Array, decodeBytesToText, encodeTextToBytes, encodeUint8ArrayToBase64 } from "../core/encoding.js";

export function decodeDocsFileContent(data) {
  return data?.base64 ? decodeBytesToText(decodeBase64ToUint8Array(data.base64)) : "";
}

export function createTiptapFileIo(targetFile, {
  getExpectedMtime,
  setMtime,
  onSaving,
} = {}) {
  async function loadFile() {
    const response = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || response.statusText || "Failed to load file");
    }
    setMtime?.(typeof data?.mtimeMs === "number" ? data.mtimeMs : null);
    return decodeDocsFileContent(data);
  }

  async function saveFile(content, { renderSaving = true } = {}) {
    onSaving?.({ renderSaving });
    const response = await fetch("/api/docs/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: targetFile,
        base64: encodeUint8ArrayToBase64(encodeTextToBytes(content)),
        expectedMtimeMs: getExpectedMtime?.() ?? null,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || response.statusText || "Failed to save file");
    }
    setMtime?.(typeof data?.mtimeMs === "number" ? data.mtimeMs : getExpectedMtime?.() ?? null);
  }

  return { loadFile, saveFile };
}
