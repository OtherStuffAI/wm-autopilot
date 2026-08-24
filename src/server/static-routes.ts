import {
  compressResponse,
  type StaticAssetService,
} from "./static-assets";

export const STATIC_ASSET_VERSION = "59";

const SPA_ROUTE_PREFIXES = [
  "/apps",
  "/projects",
  "/todos",
  "/docs",
  "/files",
  "/live",
  "/chat",
  "/settings",
  "/nightwatch",
  "/scheduler",
  "/triggers",
  "/pipelines",
  "/terminal",
];

const SPA_ROUTE_PATHS = new Set([
  "/home",
  "/privacy",
  ...SPA_ROUTE_PREFIXES,
]);

export function isSpaRoutePath(pathname: string): boolean {
  if (SPA_ROUTE_PATHS.has(pathname)) return true;
  return SPA_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(`${prefix}/`));
}

export async function serveIndex(
  assetVersion = STATIC_ASSET_VERSION,
  bootConfig?: Record<string, unknown> | null,
): Promise<Response> {
  const url = new URL("../ui/index.html", import.meta.url);
  let html = await Bun.file(url).text();
  html = html.replace(
    /href="\/styles\.css"/,
    `href="/styles.css?v=${assetVersion}"`,
  );
  html = html.replace(
    /src="\/app\.js"/,
    `src="/app.js?v=${assetVersion}"`,
  );
  if (bootConfig) {
    const json = JSON.stringify(bootConfig)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
    html = html.replace(
      /<\/head>/,
      `<script>window.__WINGMAN_CONFIG__=${json}</script></head>`,
    );
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

export interface StaticRouteHandlerOptions {
  assetService: StaticAssetService;
  assetVersion?: string;
  resolveBootConfig?: () => Record<string, unknown> | null;
}

export interface StaticRouteHandler {
  serveBeforeApi: (request: Request, pathname: string) => Promise<Response | undefined>;
  serveAfterApi: (request: Request, pathname: string) => Promise<Response>;
}

export function createStaticRouteHandler(options: StaticRouteHandlerOptions): StaticRouteHandler {
  const { assetService, assetVersion = STATIC_ASSET_VERSION, resolveBootConfig } = options;

  const serveBeforeApi = async (request: Request, pathname: string): Promise<Response | undefined> => {
    if (isSpaRoutePath(pathname) && !assetService.isUiAssetPath(pathname)) {
      const bootConfig = resolveBootConfig?.() ?? null;
      return compressResponse(request, await serveIndex(assetVersion, bootConfig));
    }

    const earlyUiAsset = assetService.resolveUiAsset(pathname);
    if (earlyUiAsset) {
      return compressResponse(request, earlyUiAsset);
    }

    return undefined;
  };

  const serveAfterApi = async (request: Request, pathname: string): Promise<Response> => {
    const aceAsset = assetService.serveAceBuildsAsset(pathname);
    if (aceAsset) {
      return compressResponse(request, aceAsset);
    }

    const vendorAsset = await assetService.serveVendorModule(pathname);
    if (vendorAsset) {
      return vendorAsset;
    }

    const assetResponse = assetService.resolveUiAsset(pathname);
    if (assetResponse) {
      return compressResponse(request, assetResponse);
    }

    const publicAsset = assetService.servePublicAsset(pathname);
    if (publicAsset) {
      return compressResponse(request, publicAsset);
    }

    return new Response("Not Found", { status: 404 });
  };

  return {
    serveBeforeApi,
    serveAfterApi,
  };
}
