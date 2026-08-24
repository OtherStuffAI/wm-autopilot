import { encodeUint8ArrayToBase64 } from "../core/encoding.js";
import { toDisplayImageSrc } from "./file-paths.js";

function guessImageExtension(mimeType) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/svg+xml") return "svg";
  return "png";
}

function createPastedImageFilename(file) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const random = Math.random().toString(36).slice(2, 8);
  return `pasted-image-${stamp}-${random}.${guessImageExtension(file?.type)}`;
}

export async function uploadPastedImage(file, fileDirectory) {
  const uploadName = createPastedImageFilename(file);
  const base64 = encodeUint8ArrayToBase64(new Uint8Array(await file.arrayBuffer()));
  const response = await fetch("/api/docs/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      directory: fileDirectory,
      name: uploadName,
      base64,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || response.statusText || "Failed to upload pasted image");
  }
  return data?.name || uploadName;
}

export function handleImagePaste(event, activeEditor, {
  fileDirectory,
  showToast,
  onUploaded,
} = {}) {
  const images = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file) => file instanceof File);
  if (images.length === 0) return false;

  event.preventDefault();
  void (async () => {
    let uploaded = 0;
    for (const image of images) {
      try {
        const savedName = await uploadPastedImage(image, fileDirectory);
        activeEditor.chain().focus().setImage({
          src: toDisplayImageSrc(fileDirectory, savedName),
          rawSrc: savedName,
          alt: savedName,
        }).run();
        uploaded += 1;
      } catch (error) {
        showToast?.(error instanceof Error ? error.message : "Failed to upload pasted image", { type: "error" });
      }
    }
    if (uploaded > 0) {
      onUploaded?.(uploaded);
      showToast?.(`Uploaded ${uploaded} image${uploaded > 1 ? "s" : ""}`, { duration: 2000 });
    }
  })();
  return true;
}
