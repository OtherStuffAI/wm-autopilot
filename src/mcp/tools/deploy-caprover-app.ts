/**
 * MCP Tool: deploy_caprover_app
 *
 * Deploy a CapRover app from a Docker image or by tarball upload
 * from the linked local app directory.
 */

import { z } from "zod";

export const deployCaproverAppSchema = {
  app_id: z
    .string()
    .describe("The CapRover app tracking ID (from list_caprover_apps)"),
  docker_image: z
    .string()
    .optional()
    .describe("Docker image to deploy (e.g. 'myregistry/myapp:latest'). If omitted, deploys via tarball from the linked local app directory"),
  git_hash: z
    .string()
    .optional()
    .describe("Git commit hash to associate with this deployment"),
  caprover_target: z
    .string()
    .optional()
    .describe('CapRover target name to deploy to, or "all" for every configured target. Defaults to all.'),
  enable_https: z
    .boolean()
    .optional()
    .describe("Enable HTTPS on the CapRover default subdomain after deployment"),
};

export const deployCaproverAppDescription =
  "Deploy a CapRover app from a Docker image. Use list_caprover_apps " +
  "first to find the app tracking ID. Returns the deployment result " +
  "including the new version number.";

interface DeployCaproverAppParams {
  app_id: string;
  docker_image?: string;
  git_hash?: string;
  caprover_target?: string;
  enable_https?: boolean;
}

export async function handleDeployCaproverApp(
  params: DeployCaproverAppParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { app_id, docker_image, git_hash, caprover_target, enable_https } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/caprover/deploy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          appId: app_id,
          dockerImage: docker_image,
          gitHash: git_hash,
          caproverTarget: caprover_target,
          enableHttps: enable_https,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Deployment failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      deployMethod?: string;
      targets?: Array<{ targetName: string; success: boolean; httpsEnabled?: boolean; httpsError?: string | null }>;
      caproverName: string;
      dockerImage?: string;
      fileCount?: number;
      deployedVersion?: number;
    };
    const method = result.deployMethod === "tar_upload" ? "tarball" : "image";
    const targets = Array.isArray(result.targets)
      ? `  Targets: ${result.targets.map((target: { targetName: string; success: boolean }) => `${target.targetName}:${target.success ? "ok" : "failed"}`).join(", ")}`
      : null;
    const https = Array.isArray(result.targets)
      ? `  HTTPS: ${result.targets.map((target: { targetName: string; httpsEnabled?: boolean; httpsError?: string | null }) => `${target.targetName}:${target.httpsEnabled ? "enabled" : target.httpsError ? "failed" : "skipped"}`).join(", ")}`
      : null;
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Deployment successful (${method})`,
            `  App: ${result.caproverName}`,
            result.dockerImage ? `  Image: ${result.dockerImage}` : `  Files: ${result.fileCount ?? "unknown"}`,
            targets,
            https,
            `  Version: ${result.deployedVersion ?? "unknown"}`,
          ].filter(Boolean).join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to reach Wingman server: ${(err as Error).message}`,
        },
      ],
    };
  }
}
