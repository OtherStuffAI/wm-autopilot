const QR_VENDOR_SRC = "/vendor/qrcode-generator.js";
const QR_CODE_SIZE = 240;
const QR_CODE_MARGIN = 4;
const QR_FOREGROUND = "#111";
const QR_BACKGROUND = "#fff";

let qrScriptPromise = null;

const loadQrLibrary = () => {
  if (typeof globalThis === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("QR library unavailable in this environment"));
  }
  if (typeof globalThis.qrcode === "function") {
    return Promise.resolve(globalThis.qrcode);
  }
  if (!qrScriptPromise) {
    qrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = QR_VENDOR_SRC;
      script.async = true;
      script.addEventListener("load", () => {
        if (typeof globalThis.qrcode === "function") {
          resolve(globalThis.qrcode);
        } else {
          reject(new Error("QR library failed to initialize"));
        }
      });
      script.addEventListener("error", () => {
        reject(new Error("Failed to load QR library"));
      });
      document.head.append(script);
    });
  }
  return qrScriptPromise;
};

const renderQrCode = async (value, canvas, options = {}) => {
  if (!canvas || typeof canvas.getContext !== "function") {
    return false;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const qrcode = await loadQrLibrary();
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const modules = qr.getModuleCount();
    const margin = Number.isFinite(options.margin) ? Number(options.margin) : QR_CODE_MARGIN;
    const size = Number.isFinite(options.size) ? Number(options.size) : QR_CODE_SIZE;
    const cellSize = Math.max(1, Math.floor((size - margin * 2) / modules));
    const outputSize = cellSize * modules + margin * 2;
    if (canvas.width !== outputSize) {
      canvas.width = outputSize;
    }
    if (canvas.height !== outputSize) {
      canvas.height = outputSize;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = options.backgroundColor ?? QR_BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = options.foregroundColor ?? QR_FOREGROUND;
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (!qr.isDark(row, col)) continue;
        const x = margin + col * cellSize;
        const y = margin + row * cellSize;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    }
    return true;
  } catch (error) {
    console.warn("[identity][qr] failed to render QR", error instanceof Error ? error.message : error);
    return false;
  }
};

export { renderQrCode };
