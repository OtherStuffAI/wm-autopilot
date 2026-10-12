import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RecordSyncCache, type Fence } from "./record-sync-cache.ts";
import { registration, page, type JsonRecord } from "./record-sync-protocol.ts";
import { change, pagePayload } from "./record-sync-fixture.test-helper.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cache-v2-"));
  const path = join(root, "cache.sqlite");
  const partition = ["tower", "workspace", "app", "viewer"];
  const cache = new RecordSyncCache(path, partition);
  function fence(): Fence {
    const s = cache.state();
    return { clientId: s.clientId, generation: s.generation, cursor: s.cursor };
  }
  function r(cursor: string | null = null, revision = "0") {
    return registration(
      {
        protocol_version: 2,
        client_id: cache.state().clientId,
        authority_epoch: "epoch",
        initial_cursor: "bootstrap",
        checkpoint_cursor: cursor,
        checkpoint_revision: revision,
      },
      cache.state().clientId,
    );
  }
  cache.register(r(), fence());
  function p(value: JsonRecord, cursor = "page-1") {
    return page(
      { ...value, client_id: cache.state().clientId, next_cursor: cursor },
      cache.state().clientId,
      "workspace",
    );
  }
  return {
    root,
    path,
    partition,
    cache,
    fence,
    r,
    p,
    close() {
      cache.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
describe("transactional cache", () => {
  test("local commit failure rolls back rows actors cursor access and ack intent", () => {
    const f = fixture();
    try {
      f.cache.db.exec(
        "CREATE TRIGGER fail_intent BEFORE INSERT ON ack_intents BEGIN SELECT RAISE(ABORT,'disk write failure'); END;",
      );
      expect(() =>
        f.cache.commit(
          f.p(
            pagePayload([change("row")], false, {
              actors: [
                {
                  actor_id: "actor",
                  npub: "npub",
                  kind: "human",
                  display_name: null,
                },
              ],
            }),
          ),
          f.fence(),
          true,
        ),
      ).toThrow("disk write failure");
      expect(f.cache.counts()).toEqual({});
      expect(f.cache.state().cursor).toBe("bootstrap");
      expect(f.cache.pending()).toBeNull();
      expect(
        (
          f.cache.db.query("SELECT count(*) AS n FROM actors").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      f.close();
    }
  });
  test("one writer lease, expired writer fencing and duplicate cursor rejection", () => {
    const f = fixture();
    try {
      expect(() => new RecordSyncCache(f.path, f.partition)).toThrow("lease");
      const expected = f.fence();
      f.cache.commit(f.p(pagePayload([change("a")])), expected, true);
      expect(() => f.cache.commit(f.p(pagePayload()), expected, true)).toThrow(
        "Stale page",
      );
      f.cache.ack(f.r("page-1", "1"), f.cache.pending()!);
      expect(() =>
        f.cache.commit(f.p(pagePayload([], true)), f.fence(), true),
      ).toThrow("Duplicate");
      f.cache.db.query("UPDATE lease SET token='other' WHERE id=1").run();
      expect(() =>
        f.cache.commit(f.p(pagePayload([], true), "page-2"), f.fence(), true),
      ).toThrow("Stale cache writer");
    } finally {
      f.close();
    }
  });
  test("BigInt tombstones defeat stale upserts; permission loss retains rows but excludes evidence", () => {
    const f = fixture();
    try {
      f.cache.commit(
        f.p(
          pagePayload([
            change("a", "task", "9007199254740993", {
              updated_at: new Date().toISOString(),
            }),
          ]),
        ),
        f.fence(),
        true,
      );
      f.cache.ack(f.r("page-1", "1"), f.cache.pending()!);
      const deletion = {
        ...change("a", "task", "9007199254740995"),
        operation: "delete",
        row: null,
      };
      f.cache.commit(
        f.p(
          pagePayload(
            [deletion, change("a", "task", "9007199254740994")],
            true,
          ),
          "page-2",
        ),
        f.fence(),
        true,
      );
      f.cache.ack(f.r("page-2", "2"), f.cache.pending()!);
      expect(f.cache.counts()).toEqual({});
      f.cache.commit(
        f.p(
          pagePayload(
            [
              change("a", "task", "9007199254740996", {
                updated_at: new Date().toISOString(),
              }),
            ],
            true,
            {
              access_changes: [
                {
                  family: "task",
                  resource_type: "channel",
                  resource_id: "channel",
                  status: "lost",
                },
              ],
            },
          ),
          "page-3",
        ),
        f.fence(),
        true,
      );
      expect(f.cache.counts().task).toBe(1);
      expect(f.cache.review("2020").rows).toEqual([]);
      expect(f.cache.review("2020").unavailable).toBe(1);
      const pending = f.cache.pending();
      f.cache.unavailable();
      expect(f.cache.pending()).toEqual(pending);
      expect(f.cache.review("2020").rows).toEqual([]);
    } finally {
      f.close();
    }
  });
  test("lost ack response reconciles exact cursor; conflict replays from committed position", () => {
    const f = fixture();
    try {
      f.cache.commit(f.p(pagePayload([change("a")])), f.fence(), true);
      const intent = f.cache.pending()!;
      f.cache.replayConflict(f.r("server-ahead", "9"), intent);
      expect(f.cache.state().cursor).toBe("page-1");
      expect(f.cache.counts().task).toBe(1);
      expect(f.cache.pending()).toBeNull();
      f.cache.commit(f.p(pagePayload([], true), "page-2"), f.fence(), true);
      expect(() =>
        f.cache.ack(f.r("server-ahead", "10"), f.cache.pending()!),
      ).toThrow("committed rows");
      f.cache.ack(f.r("page-2", "10"), f.cache.pending()!);
      expect(f.cache.pending()).toBeNull();
    } finally {
      f.close();
    }
  });
  test("repair preserves pending intent and old rows without authority", () => {
    const f = fixture();
    try {
      f.cache.commit(f.p(pagePayload([change("a")])), f.fence(), true);
      const old = f.cache.state();
      f.cache.repair();
      expect(f.cache.state().clientId).not.toBe(old.clientId);
      expect(f.cache.counts()).toEqual({});
      expect(f.cache.state().available).toBe(false);
      expect(
        (
          f.cache.db.query("SELECT status FROM ack_intents").get() as {
            status: string;
          }
        ).status,
      ).toBe("repair");
      expect(
        (
          f.cache.db.query("SELECT count(*) AS n FROM rows").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
      expect(() =>
        f.cache.register(
          registration(
            {
              protocol_version: 2,
              client_id: f.cache.state().clientId,
              authority_epoch: "epoch",
              initial_cursor: "initial",
              checkpoint_cursor: "server-only",
              checkpoint_revision: "1",
            },
            f.cache.state().clientId,
          ),
          f.fence(),
        ),
      ).toThrow("rows absent");
    } finally {
      f.close();
    }
  });
  test("pending intent and canonical rows survive a separate process exiting after local commit", () => {
    const root = mkdtempSync(join(tmpdir(), "restart-v2-"));
    const path = join(root, "cache.sqlite");
    const script = join(root, "commit.ts");
    try {
      writeFileSync(
        script,
        `import {RecordSyncCache} from ${JSON.stringify(join(import.meta.dir, "record-sync-cache.ts"))};
      const c=new RecordSyncCache(${JSON.stringify(path)},["partition"],10000);
      const s=c.state();c.register({protocol_version:2,client_id:s.clientId,authority_epoch:"epoch",initial_cursor:"initial",checkpoint_cursor:null,checkpoint_revision:"0"},{clientId:s.clientId,generation:s.generation,cursor:null});
      c.db.query("UPDATE lease SET expires=?").run(Date.now()+10000);
      c.commit({...${JSON.stringify(pagePayload([change("durable")]))},client_id:s.clientId,next_cursor:"committed"},{clientId:s.clientId,generation:s.generation,cursor:"initial"},true);
      c.db.query("UPDATE lease SET expires=0").run();process.exit(7);`,
      );
      const child = spawnSync("bun", [script], { encoding: "utf8" });
      expect(child.status).toBe(7);
      const c = new RecordSyncCache(path, ["partition"]);
      try {
        expect(c.counts().task).toBe(1);
        expect(c.state().cursor).toBe("committed");
        expect(c.pending()?.cursor).toBe("committed");
      } finally {
        c.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
test("old active tasks appear in bounded review and moves use current canonical ownership", () => {
  const f = fixture();
  try {
    const old = change("old", "task", "9007199254740993", {
      state: "in_progress",
    });
    f.cache.commit(f.p(pagePayload([old])), f.fence(), true);
    f.cache.ack(f.r("page-1", "1"), f.cache.pending()!);
    expect(f.cache.review(new Date().toISOString()).rows[0]?.id).toBe("old");
    const moved = {
      ...change("old", "task", "9007199254740994", {
        state: "review",
        channel_id: "new-channel",
      }),
      channel_id: "new-channel",
    };
    f.cache.commit(
      f.p(
        pagePayload([moved], true, {
          access_changes: [
            {
              family: "task",
              resource_type: "channel",
              resource_id: "channel",
              status: "lost",
            },
          ],
        }),
        "page-2",
      ),
      f.fence(),
      true,
    );
    expect(f.cache.review(new Date().toISOString()).rows[0]?.channel).toBe(
      "new-channel",
    );
  } finally {
    f.close();
  }
});
test("local ack completion failure leaves durable retry intent", () => {
  const f = fixture();
  try {
    f.cache.commit(f.p(pagePayload([change("acked")])), f.fence(), true);
    const intent = f.cache.pending()!;
    f.cache.db.exec("CREATE TRIGGER fail_ack BEFORE DELETE ON ack_intents BEGIN SELECT RAISE(ABORT,'ack disk failure'); END;");
    expect(() => f.cache.ack(f.r("page-1", "1"), intent)).toThrow("ack disk failure");
    expect(f.cache.pending()).toEqual(intent);
    expect(f.cache.state().revision).toBe("0");
    expect(f.cache.counts().task).toBe(1);
  } finally { f.close(); }
});
