/**
 * 增量标注的调度（PLAN.md FR-A12）。
 *
 * 实现：**MutationObserver 只记账，扫描放在 `requestIdleCallback` 里做**。
 * 不用 IntersectionObserver 做视口裁剪，扫描范围按脏节点走，不按视口裁剪
 * （PLAN.md FR-A12 的视口口径尚未实现，现状见 `TECH.md` §2.1）。
 * 验收：长页面滚动不卡顿；**且标注行为本身不得再触发 MutationObserver 形成循环**。
 *
 * 两条调研结论决定了这里的形状（`docs/reference/dom-observers.md` §3、§4）：
 *
 * 1. **MutationObserver 的回调是微任务**（在当前任务结束后、渲染前派发），
 *    因此在回调里做标注不会造成可见闪烁。但一次回调可能带多条记录，必须批量处理。
 *
 * 2. **`IntersectionObserver` 观察的是 Element，不是文本节点或 Range**。
 *    所以无法直接问"这个文本节点在不在视口内"——只能观察它**所属的元素**。
 *    这是本项目不用它做视口裁剪的原因：粒度天然比"按文本节点"粗。
 *
 * 调度策略：MutationObserver 只负责"**记账**"（把脏子树攒起来），
 * 真正的扫描放在 `requestIdleCallback`（没有则退回微任务）里做，
 * 且同一批多次变更只扫一次。这样突发大量 DOM 变更时不会反复触发全量扫描。
 */

/** 我们的调度器不碰 DOM，只调注入进来的回调——因此可单测 */
export interface SchedulerEnv {
  /** 派一个空闲回调；返回取消句柄 */
  schedule(callback: () => void): number;
  cancel(handle: number): void;
}

export interface AnnotationScheduler {
  /** 标记一处子树变脏 */
  markDirty(node: Node): void;
  /** 立即跑一次（用于首次注入、开关恢复） */
  flush(): void;
  /** 停止并取消待跑的任务 */
  stop(): void;
  /** 待处理是否为空（诊断与测试用） */
  isIdle(): boolean;
}

/**
 * 造一个调度器。
 *
 * `process` 收到的是**去重后的脏节点列表**。去重有一条重要规则：
 * 若某个节点的祖先已经在列表里，就丢掉这个节点——扫祖先时会把子孙一起扫到，
 * 重复处理同一片文本既浪费又可能造成同一次标注被注册两遍。
 */
export function createScheduler(
  env: SchedulerEnv,
  process: (nodes: Node[]) => void,
): AnnotationScheduler {
  const dirty = new Set<Node>();
  let handle: number | null = null;

  function isAncestorOf(ancestor: Node, node: Node): boolean {
    let current: Node | null = node.parentNode;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentNode;
    }
    return false;
  }

  function run(): void {
    handle = null;
    if (dirty.size === 0) return;

    // 收敛：丢掉那些已经有祖先在集合里的节点
    const nodes: Node[] = [];
    for (const node of dirty) {
      let covered = false;
      for (const other of dirty) {
        if (other !== node && isAncestorOf(other, node)) {
          covered = true;
          break;
        }
      }
      if (!covered) nodes.push(node);
    }
    dirty.clear();

    process(nodes);
  }

  function ensureScheduled(): void {
    if (handle !== null) return;
    handle = env.schedule(run);
  }

  return {
    markDirty(node) {
      dirty.add(node);
      ensureScheduled();
    },

    flush() {
      if (handle !== null) {
        env.cancel(handle);
        handle = null;
      }
      run();
    },

    stop() {
      if (handle !== null) {
        env.cancel(handle);
        handle = null;
      }
      dirty.clear();
    },

    isIdle: () => handle === null && dirty.size === 0,
  };
}

/**
 * 用真实浏览器 API 造调度环境。
 *
 * 优先 `requestIdleCallback`：扫描是低优先级工作，不该和页面自己的交互抢主线程
 * （FR-A12 的"长页面滚动不卡顿"）。不支持时退回 `setTimeout(0)`——
 * 微任务不合适，因为它会在**同一次** DOM 变更的微任务队列里跑，
 * 页面连续插入节点时会每插一次就扫一次。
 */
export function createBrowserSchedulerEnv(win: Window = window): SchedulerEnv {
  const ric = (win as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  const cic = (win as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;

  if (typeof ric === 'function') {
    return {
      // timeout 兜底：持续繁忙的页面里 idle 回调可能长期得不到执行，
      // 标注就会被无限推迟。2 秒是"宁可稍微打断也不要不标注"的折中。
      schedule: (cb) => ric(cb, { timeout: 2000 }),
      cancel: (h) => cic?.(h),
    };
  }

  return {
    schedule: (cb) => win.setTimeout(cb, 0),
    cancel: (h) => win.clearTimeout(h),
  };
}

/**
 * 起一个 MutationObserver，把变更喂给调度器。
 *
 * **只观察 `childList` + `characterData` + `subtree`**：
 * `attributes` 不需要开——属性变化不产生新文本，开了只会白白增加回调次数（§3）。
 *
 * **不会形成循环**：标注走 CSS Custom Highlight API，**不改 DOM**，
 * 因此我们的标注动作不会产生 mutation record。这正是 FR-A12 验收里
 * "不得形成循环"能成立的根本原因——一旦有人把标注改成 DOM 包裹方案，
 * 这个循环立刻出现（也是禁止该方案的另一条理由）。
 */
export function observeMutations(
  target: Node,
  scheduler: AnnotationScheduler,
  Observer: typeof MutationObserver = MutationObserver,
): MutationObserver {
  const observer = new Observer((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        // 新增的节点才是新文本的来源；删除不影响标注（Range 由 UA 跟随）
        for (const node of Array.from(mutation.addedNodes)) {
          // 只关心元素与文本；注释节点等没有可标注内容
          if (node.nodeType === 1 || node.nodeType === 3) scheduler.markDirty(node);
        }
      } else if (mutation.type === 'characterData') {
        if (mutation.target) scheduler.markDirty(mutation.target);
      }
    }
  });

  observer.observe(target, {
    childList: true,
    characterData: true,
    subtree: true,
    // attributes 明确不开：属性变化不产生新文本
  });

  return observer;
}
