import { createHash } from "node:crypto";

/** Parse dimensions before image bytes enter model context. Never infer MIME from a URL. */
export function validateImage(bytes: Buffer, mimeType: string) {
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw Error("Image byte limit exceeded");
  let width = 0, height = 0;
  if (mimeType === "image/png" && bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR") {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (mimeType === "image/webp" && bytes.length >= 30 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const type = bytes.toString("ascii",12,16);
    if (type === "VP8X") { width = bytes.readUIntLE(24,3) + 1; height = bytes.readUIntLE(27,3) + 1; }
    else if (type === "VP8 " && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) {width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383;}
    else if (type === "VP8L" && bytes[20] === 47) {const n = bytes.readUInt32LE(21); width = (n & 16383) + 1; height = ((n >>> 14) & 16383) + 1;}
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 12_000_000) throw Error("Invalid image MIME, magic or dimensions");
  return {width, height, sha256: createHash("sha256").update(bytes).digest("hex")};
}
