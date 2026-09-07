import { describe, expect, it, vi } from "vitest";
import { BusyStatus } from "./busy-status";

describe("BusyStatus contextual ownership", () => {
  it.each(["settled", "disposed"] as const)(
    "does not expose a %s owner to a detached callback",
    async (lifecycle) => {
      const render = vi.fn();
      const busy = new BusyStatus(render);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let detached!: Promise<string | undefined>;
      await busy.run("owner", () => {
        expect(busy.getMessage()).toBe("owner");
        detached = released.then(() => {
          busy.setMessage("detached");
          return busy.getMessage();
        });
        if (lifecycle === "disposed") {
          busy.dispose();
        }
      });
      render.mockClear();
      release();
      expect(await detached).toBeUndefined();
      expect(render).not.toHaveBeenCalled();
    }
  );

  it("restores the live parent context after a nested operation", async () => {
    const busy = new BusyStatus(vi.fn());
    await busy.run("parent", async () => {
      await busy.run("child", () => {
        busy.setMessage("updated");
        expect(busy.getMessage()).toBe("updated");
      });
      expect(busy.getMessage()).toBe("parent");
    });
    expect(busy.getMessage()).toBeUndefined();
    busy.dispose();
    await busy.run("after-disposal", () => {
      expect(busy.getMessage()).toBeUndefined();
    });
  });
});
