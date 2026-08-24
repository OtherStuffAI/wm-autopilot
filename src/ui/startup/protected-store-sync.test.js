import { describe, expect, mock, test } from "bun:test";

import { syncAuthenticatedStartupStores } from "./protected-store-sync.js";

describe("syncAuthenticatedStartupStores", () => {
  test("syncs authenticated startup stores and leaves Night Watch idle", async () => {
    const schedulerSync = mock(async () => {});
    const nightWatchSync = mock(async () => {});
    const stores = {
      scheduler: { sync: schedulerSync },
      nightwatch: { sync: nightWatchSync },
    };

    await syncAuthenticatedStartupStores({
      Alpine: {
        store(name) {
          return stores[name];
        },
      },
    });

    expect(schedulerSync).toHaveBeenCalledTimes(1);
    expect(nightWatchSync).not.toHaveBeenCalled();
  });
});
