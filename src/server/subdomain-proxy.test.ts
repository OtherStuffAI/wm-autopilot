import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proxyRequestToApp } from "./subdomain-proxy";

let upstream: ReturnType<typeof Bun.serve>;
let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/login") {
        return Response.json(
          {
            cookie: request.headers.get("cookie"),
            authorization: request.headers.get("authorization"),
          },
          {
            headers: {
              "set-cookie": "wapp_session=fresh; HttpOnly; Secure; SameSite=Strict; Path=/",
            },
          },
        );
      }

      if (url.pathname === "/redirect") {
        return Response.redirect(new URL("/login", request.url), 302);
      }

      if (url.pathname === "/assets/index-BA7EPZA7.js") {
        return new Response("console.log('hashed');", {
          headers: {
            "cache-control": "max-age=30",
            "content-type": "text/javascript",
          },
        });
      }

      if (url.pathname === "/assets/private-BA7EPZA7.json") {
        return Response.json({ private: true }, {
          headers: { "cache-control": "private, no-store" },
        });
      }

      if (url.pathname === "/assets/missing-BA7EPZA7.js") {
        return new Response("<!doctype html><title>Fallback</title>", {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/html",
          },
        });
      }

      if (
        url.pathname === "/index.html"
        || url.pathname === "/assets/index.js"
        || url.pathname === "/service-worker-BA7EPZA7.js"
      ) {
        return new Response("mutable", {
          headers: { "cache-control": "no-cache" },
        });
      }

      if (url.pathname === "/stream") {
        return new Response(new ReadableStream({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode("first"));
          },
        }));
      }

      return new Response("Not found", { status: 404 });
    },
  });
});

afterAll(() => upstream.stop(true));

describe("managed app HTTP proxy", () => {
  test("forwards app credentials and Set-Cookie", async () => {
    const response = await proxyRequestToApp(
      new Request("https://time.example.test/login", {
        headers: {
          host: "time.example.test",
          cookie: "wapp_session=existing",
          authorization: "Nostr signed-event",
        },
      }),
      upstream.port,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cookie: "wapp_session=existing",
      authorization: "Nostr signed-event",
    });
    expect(response.headers.get("set-cookie")).toContain("wapp_session=fresh");
  });

  test("returns redirects to the browser and preserves the public origin", async () => {
    const response = await proxyRequestToApp(
      new Request("https://time.example.test/redirect", {
        headers: { host: "time.example.test" },
      }),
      upstream.port,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://time.example.test/login");
  });

  test("uses the trusted forwarded origin behind the public TLS proxy", async () => {
    const response = await proxyRequestToApp(
      new Request("http://127.0.0.1/redirect", {
        headers: {
          host: "127.0.0.1",
          "x-forwarded-host": "time.example.test",
          "x-forwarded-proto": "https",
        },
      }),
      upstream.port,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://time.example.test/login");
  });

  test("makes Vite-hashed assets immutable", async () => {
    const response = await proxyRequestToApp(
      new Request("https://time.example.test/assets/index-BA7EPZA7.js?build=current"),
      upstream.port,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control"))
      .toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log('hashed');");
  });

  test.each([
    "/index.html",
    "/assets/index.js",
    "/service-worker-BA7EPZA7.js",
  ])("preserves mutable caching for %s", async (pathname) => {
    const response = await proxyRequestToApp(
      new Request(`https://time.example.test${pathname}`),
      upstream.port,
    );

    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("does not cache HTML fallbacks or explicitly private hashed responses", async () => {
    const htmlFallback = await proxyRequestToApp(
      new Request("https://time.example.test/assets/missing-BA7EPZA7.js"),
      upstream.port,
    );
    const privateResponse = await proxyRequestToApp(
      new Request("https://time.example.test/assets/private-BA7EPZA7.json"),
      upstream.port,
    );

    expect(htmlFallback.headers.get("cache-control")).toBe("no-cache");
    expect(privateResponse.headers.get("cache-control")).toBe("private, no-store");
  });

  test("returns response headers before the upstream body completes", async () => {
    const response = await Promise.race([
      proxyRequestToApp(
        new Request("https://time.example.test/stream"),
        upstream.port,
      ),
      Bun.sleep(250).then(() => {
        throw new Error("proxy buffered the upstream body");
      }),
    ]);

    expect(response.status).toBe(200);
    streamController?.enqueue(new TextEncoder().encode("-last"));
    streamController?.close();
    streamController = null;
    expect(await response.text()).toBe("first-last");
  });
});
