import { describe, expect, test } from "bun:test";

import { buildGooseRuntimeEnv } from "./goose-adapter";
import { buildPiRpcArgs } from "./pi-rpc-client";
import type { AdapterSessionContext } from "./agent-adapter";

describe("runtime model propagation", () => {
  test("passes Goose a provider-relative model through its environment contract", () => {
    const env = buildGooseRuntimeEnv({
      id: "goose-session",
      port: 3700,
      agent: "goose",
      host: "127.0.0.1",
      model: "anthropic/claude-opus-5-fast",
      gooseProvider: "openrouter",
      env: {},
    } satisfies AdapterSessionContext);

    expect(env.GOOSE_PROVIDER).toBe("openrouter");
    expect(env.GOOSE_MODEL).toBe("anthropic/claude-opus-5-fast");
  });

  test("keeps the fixed OpenRouter provider when a legacy provider value is also present", () => {
    const env = buildGooseRuntimeEnv({
      id: "goose-session",
      port: 3700,
      agent: "goose",
      host: "127.0.0.1",
      model: "qwen/qwen3.7-flash",
      gooseProvider: "openai",
      env: { GOOSE_PROVIDER: "openrouter" },
    });

    expect(env.GOOSE_PROVIDER).toBe("openrouter");
  });

  test("passes Pi its OpenRouter-qualified model on RPC startup", () => {
    expect(buildPiRpcArgs({
      sessionDirectory: "/tmp/pi-session",
      model: "openrouter/anthropic/claude-opus-5-fast",
    })).toEqual([
      "--model",
      "openrouter/anthropic/claude-opus-5-fast",
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/pi-session",
    ]);
  });
});

test("completed Goose provider ignores stale generic credentials and pins managed OpenRouter host",()=>{
 const context:any={id:"test",agent:"goose",host:"localhost",port:1,gooseCompletedTurn:true,model:"z-ai/glm-5.3",env:{OPENROUTER_API_KEY:"managed",OPENROUTER_HOST:"http://localhost:1234/scoped",GOOSE_PROVIDER:"other",GOOSE_PROVIDER__API_KEY:"foreign",GOOSE_PROVIDER__HOST:"https://foreign"}};
 const env=buildGooseRuntimeEnv(context);expect(env.GOOSE_PROVIDER).toBe("openrouter");expect(env.GOOSE_MODEL).toBe("z-ai/glm-5.3");expect(env.GOOSE_PROVIDER__API_KEY).toBe("managed");expect(env.GOOSE_PROVIDER__HOST).toBe("http://localhost:1234/scoped");
 expect(()=>buildGooseRuntimeEnv({...context,env:{OPENROUTER_API_KEY:"",GOOSE_PROVIDER__API_KEY:"foreign"}})).toThrow("managed OpenRouter");
});
