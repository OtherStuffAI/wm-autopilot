import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("live layout CSS", () => {
  test("uses most of the viewport for wide content routes", () => {
    const rule = styles.match(/#app\[data-route="files"\],[\s\S]+?#app\[data-route="live"\]\s*\{(?<body>[^}]+)\}/);

    expect(rule?.groups?.body).toContain("max-width: 90vw;");
    expect(rule?.groups?.body).toContain("width: 90vw;");
    expect(rule?.[0]).toContain('#app[data-route="apps"]');
    expect(rule?.[0]).toContain('#app[data-route="scheduler"]');
    expect(rule?.[0]).toContain('#app[data-route="pipelines"]');
  });

  test("keeps the session tab bar in normal flow when split panels lock the viewport", () => {
    const rule = styles.match(/\[data-webview-open="true"\] \.wm-tabs-bar\s*\{(?<body>[^}]+)\}/);

    expect(rule?.groups?.body).toContain("position: relative;");
    expect(rule?.groups?.body).toContain("top: auto;");
    expect(rule?.groups?.body).toContain("flex: 0 0 auto;");
  });

  test("budgets the collapsed chat rail separately from artifact editor space", () => {
    const splitRule = styles.match(/\.wm-live-split\s*\{(?<body>[^}]+)\}/);
    const collapsedRule = styles.match(/\.wm-live-split--chat-collapsed\s*\{(?<body>[^}]+)\}/);
    const chatColumnRule = styles.match(/\.wm-live-split--chat-collapsed > \.wm-live-chat-col\s*\{(?<body>[^}]+)\}/);
    const artifactColumnRule = styles.match(/\.wm-live-split--chat-collapsed > \.wm-webview-col\s*\{(?<body>[^}]+)\}/);
    const commentsRule = styles.match(/\.wm-tiptap-comments\s*\{(?<body>[^}]+)\}/);

    expect(splitRule?.groups?.body).toContain("--wm-live-chat-rail-width:");
    expect(splitRule?.groups?.body).toContain("gap: var(--wm-live-split-gap);");
    expect(collapsedRule?.groups?.body).toContain("--wm-live-chat-rail-width: 3rem;");
    expect(chatColumnRule?.groups?.body).toContain("flex: 0 0 var(--wm-live-chat-rail-width);");
    expect(artifactColumnRule?.groups?.body).toContain("calc(100% - var(--wm-live-chat-rail-width) - var(--wm-live-split-gap))");
    expect(commentsRule?.groups?.body).toContain("width: clamp(18rem, 24vw, 22rem);");
  });

  test("wraps long markdown links inside message bubbles", () => {
    const messageRule = styles.match(/\.wm-message\s*\{(?<body>[^}]+)\}/);
    const bodyRule = styles.match(/\.wm-message-body,[\s\S]+?\.wm-archive-dialog-message-content\s*\{(?<body>[^}]+)\}/);
    const paragraphRule = styles.match(/\.wm-message-body p,[\s\S]+?\.wm-archive-dialog-message-content p\s*\{(?<body>[^}]+)\}/);
    const linkRule = styles.match(/\.wm-message-body a,[\s\S]+?\.wm-archive-dialog-message-content a\s*\{(?<body>[^}]+)\}/);

    expect(messageRule?.groups?.body).toContain("min-width: 0;");
    expect(bodyRule?.groups?.body).toContain("min-width: 0;");
    expect(paragraphRule?.groups?.body).toContain("overflow-wrap: anywhere;");
    expect(linkRule?.groups?.body).toContain("overflow-wrap: anywhere;");
    expect(linkRule?.groups?.body).toContain("word-break: break-word;");
  });
});
