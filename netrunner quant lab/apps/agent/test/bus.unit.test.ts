import { describe, expect, test } from "vitest";
import { publish, subscribe, replay, isTerminal } from "../src/chat/bus.js";

describe("chat bus", () => {
  test("late subscriber replays buffered events, then gets live ones in order", () => {
    const runId = `run_${Math.random()}`;
    publish(runId, "run.started", { a: 1 });
    publish(runId, "run.step", { b: 2 });

    const seen: string[] = [];
    const unsub = subscribe(runId, (ev) => seen.push(ev.type));
    expect(seen).toEqual(["run.started", "run.step"]); // replayed

    publish(runId, "message", { content: "hi" });
    expect(seen).toEqual(["run.started", "run.step", "message"]); // live
    unsub();
  });

  test("seq is monotonic per run", () => {
    const runId = `run_${Math.random()}`;
    const a = publish(runId, "run.started", {});
    const b = publish(runId, "run.step", {});
    expect(b.seq).toBe(a.seq + 1);
    expect(replay(runId).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("isTerminal flags done/error only", () => {
    const runId = `run_${Math.random()}`;
    expect(isTerminal(publish(runId, "run.step", {}))).toBe(false);
    expect(isTerminal(publish(runId, "run.done", {}))).toBe(true);
  });
});
