#!/usr/bin/env bun

import { identityUserStore } from "../src/storage/identity-user-store";

const main = () => {
  const users = identityUserStore.ensurePortAssignments();
  console.log(`Assigned ports to ${users.length} identity user${users.length === 1 ? "" : "s"}:\n`);
  users.forEach((user) => {
    const ports = user.ports.length > 0 ? user.ports.join(", ") : "none";
    console.log(`- ${user.alias} (${user.npub}): ${ports}`);
  });
};

main();
