/**
 * 增量标注调度的单测（PLAN.md FR-A12）。
 *
 * 调度器不碰 DOM，因此可以在这里逐条验收"去重、批量、不重复扫"这些行为。
 * 真实的 MutationObserver / requestIdleCallback 由注入的环境替代。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createScheduler,
  observeMutations,
  type SchedulerEnv,
} from './observe';

/** 手动触发的调度环境：把待跑回调攒起来，由测试决定何时跑 */
function manualEnv() {
  const pending = new Map<number, () => void>();
  let next = 1;
  let cancelled = 0;

  const env: SchedulerEnv = {
    schedule: (cb) => {
      const handle = next++;
      pending.set(handle, cb);
      return handle;
    },
    cancel: (handle) => {
      if (pending.delete(handle)) cancelled++;
    },
  };

  return {
    env,
    get cancelled() {
      return cancelled;
    },
    get pendingCount() {
      return pending.size;
    },
    runAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

/** 假节点：只要有 parentNode 链就够 */
function node(parent: Node | null = null): Node {
  const n = { nodeType: 1, parentNode: parent } as unknown as Node;
  return n;
}

describe('FR-A12：批量与去重', () => {
  it('一次标记只调度一次', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    scheduler.markDirty(node());
    scheduler.markDirty(node());
    scheduler.markDirty(node());

    expect(env.pendingCount).toBe(1);
    expect(process).not.toHaveBeenCalled();

    env.runAll();
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('多个脏节点合成一次处理', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    scheduler.markDirty(node());
    scheduler.markDirty(node());
    env.runAll();

    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]![0]).toHaveLength(2);
  });

  it('祖先已在列表里时丢掉子孙（扫祖先会连子孙一起扫）', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    const parent = node();
    const child = node(parent);
    const grandchild = node(child);

    scheduler.markDirty(parent);
    scheduler.markDirty(child);
    scheduler.markDirty(grandchild);
    env.runAll();

    const nodes = process.mock.calls[0]![0] as Node[];
    expect(nodes).toEqual([parent]);
  });

  it('互不相关的节点都保留', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    const a = node();
    const b = node();
    scheduler.markDirty(a);
    scheduler.markDirty(b);
    env.runAll();

    expect(process.mock.calls[0]![0]).toHaveLength(2);
  });

  it('处理完后可以再次调度（不是一次性的）', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    scheduler.markDirty(node());
    env.runAll();
    scheduler.markDirty(node());
    env.runAll();

    expect(process).toHaveBeenCalledTimes(2);
  });
});

describe('FR-A12：flush 与 stop', () => {
  it('flush 立即执行并取消已排的任务', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    scheduler.markDirty(node());
    scheduler.flush();

    expect(process).toHaveBeenCalledTimes(1);
    // 已排的回调被取消，不会跑第二遍
    env.runAll();
    expect(process).toHaveBeenCalledTimes(1);
    expect(env.cancelled).toBe(1);
  });

  it('flush 在无待处理时不调用 process', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    scheduler.flush();
    expect(process).not.toHaveBeenCalled();
  });

  it('stop 取消任务并清空待处理', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);

    scheduler.markDirty(node());
    scheduler.stop();
    env.runAll();

    expect(process).not.toHaveBeenCalled();
    expect(scheduler.isIdle()).toBe(true);
  });
});

describe('FR-A12：观察配置', () => {
  /** 记录 observe 的参数 */
  function fakeObserver() {
    const calls: Array<{ target: Node; options: MutationObserverInit }> = [];
    let callback: MutationCallback | null = null;

    class Fake implements Partial<MutationObserver> {
      constructor(cb: MutationCallback) {
        callback = cb;
      }
      observe(target: Node, options?: MutationObserverInit) {
        calls.push({ target, options: options ?? {} });
      }
      disconnect() {}
      takeRecords() {
        return [];
      }
    }

    return { calls, Fake: Fake as unknown as typeof MutationObserver, emit: (m: MutationRecord[]) => callback?.(m, {} as MutationObserver) };
  }

  it('观察 childList + characterData + subtree', () => {
    const env = manualEnv();
    const scheduler = createScheduler(env.env, vi.fn());
    const { calls, Fake } = fakeObserver();

    observeMutations(node(), scheduler, Fake);

    expect(calls).toHaveLength(1);
    const options = calls[0]!.options;
    expect(options.childList).toBe(true);
    expect(options.characterData).toBe(true);
    expect(options.subtree).toBe(true);
  });

  it('明确不观察 attributes（属性变化不产生新文本，开了只增回调次数）', () => {
    const env = manualEnv();
    const scheduler = createScheduler(env.env, vi.fn());
    const { calls, Fake } = fakeObserver();

    observeMutations(node(), scheduler, Fake);

    expect(calls[0]!.options.attributes).toBeFalsy();
  });

  it('childList 的新增节点被标记为脏', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);
    const { Fake, emit } = fakeObserver();

    observeMutations(node(), scheduler, Fake);
    const added = node();
    emit([{ type: 'childList', addedNodes: [added] } as unknown as MutationRecord]);
    env.runAll();

    expect(process).toHaveBeenCalledTimes(1);
    expect((process.mock.calls[0]![0] as Node[])[0]).toBe(added);
  });

  it('characterData 变化标记其目标节点', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);
    const { Fake, emit } = fakeObserver();

    observeMutations(node(), scheduler, Fake);
    const text = node();
    emit([{ type: 'characterData', target: text } as unknown as MutationRecord]);
    env.runAll();

    expect((process.mock.calls[0]![0] as Node[])[0]).toBe(text);
  });

  it('删除节点不触发扫描（Range 由 UA 跟随，不需要重扫）', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);
    const { Fake, emit } = fakeObserver();

    observeMutations(node(), scheduler, Fake);
    emit([{ type: 'childList', addedNodes: [], removedNodes: [node()] } as unknown as MutationRecord]);
    env.runAll();

    expect(process).not.toHaveBeenCalled();
  });

  it('一次回调带多条记录时全部记账', () => {
    const env = manualEnv();
    const process = vi.fn();
    const scheduler = createScheduler(env.env, process);
    const { Fake, emit } = fakeObserver();

    observeMutations(node(), scheduler, Fake);
    emit([
      { type: 'childList', addedNodes: [node()] } as unknown as MutationRecord,
      { type: 'childList', addedNodes: [node()] } as unknown as MutationRecord,
      { type: 'characterData', target: node() } as unknown as MutationRecord,
    ]);
    env.runAll();

    expect(process.mock.calls[0]![0]).toHaveLength(3);
  });
});
