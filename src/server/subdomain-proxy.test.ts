import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proxyRequestToApp } from "./subdomain-proxy";

let upstream: ReturnType<typeof Bun.serve>;

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
});
