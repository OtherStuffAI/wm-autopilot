/**
 * Binary encoding / decoding utilities.
 *
 * Pure functions — no framework or state dependencies.
 */

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export const decodeBase64ToUint8Array = (value) => {
  if (!value) return new Uint8Array(0);
  try {
    const binary = atob(value);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
};

export const encodeUint8ArrayToBase64 = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

export const decodeBytesToText = (bytes) => {
  if (!bytes || bytes.length === 0) return "";
  if (textDecoder) {
    try {
      return textDecoder.decode(bytes);
    } catch {
      // fall through to manual decoding
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
};

export const encodeTextToBytes = (text) => {
  if (!text || text.length === 0) return new Uint8Array(0);
  if (textEncoder) {
    try {
      return textEncoder.encode(text);
    } catch {
      // fall through to manual encoding
    }
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
};

export const readFileAsUint8Array = (file) =>
  new Promise((resolve, reject) => {
    if (!(file instanceof File)) {
      reject(new Error("Invalid file input"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      reader.abort();
      reject(new Error("Failed to read file"));
    };
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
        return;
      }
      if (ArrayBuffer.isView(result)) {
        resolve(new Uint8Array(result.buffer));
        return;
      }
      reject(new Error("Unsupported file result"));
    };
    reader.readAsArrayBuffer(file);
  });
