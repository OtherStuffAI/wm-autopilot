import { expect, test } from "bun:test";

async function rules(env: Record<string, string>) {
  const proc = Bun.spawn(["bash", new URL("./fips-control-plane-firewall.sh", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PORT: "3600", FIPS_APPS_ENABLED: "true", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("firewall adds only the configured mesh ingress port", async () => {
  expect(await rules({})).toMatchObject({ stdout: "tcp dport 3601 accept\n", code: 0 });
  expect(await rules({ FIPS_AUTOPILOT_PORT: "8080" })).toMatchObject({ stdout: "tcp dport 8080 accept\n", code: 0 });
  expect(await rules({ FIPS_AUTOPILOT_ENABLED: "false" })).toMatchObject({ stdout: "", code: 0 });
  for (const port of ["3600", "41000", "65536", "0", "abc", "3601; accept"]) {
    expect(await rules({ FIPS_AUTOPILOT_PORT: port })).toMatchObject({ stdout: "", code: 2 });
  }
});
