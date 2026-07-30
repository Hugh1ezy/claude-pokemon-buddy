// 独立于 60s 主 tick 的 buddy 动画驱动。自调度（await push 后再 sleep，不用裸
// setInterval 防积压），经 transport.push 的串行互斥推帧，diff 只发 buddy 脏区。
export function createBuddyAnimator({
  transport,
  getModel,
  render,
  intervalMs = 333,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = console,
}) {
  let running = false;
  let pauseDepth = 0;
  let phase = 0;
  let consecutiveFailures = 0;

  async function loop() {
    while (running) {
      if (pauseDepth === 0) {
        try {
          const model = getModel();
          if (model) {
            // clockMs is refreshed per FRAME, not per tick. The model itself is a
            // minute old by the end of a tick, and anything in it with a deadline
            // -- the encounter row -- has to be judged against now, not against
            // when the tick happened to run.
            const frame = await render({ ...model, clockMs: Date.now(), buddy: { ...model.buddy, animPhase: phase } });
            if (pauseDepth === 0 && running) {
              phase = (phase + 1) % 1_000_000;
              await transport.push(frame);
              consecutiveFailures = 0;
            }
          }
        } catch (error) {
          consecutiveFailures += 1;
          if (consecutiveFailures === 1 || consecutiveFailures % 30 === 0) {
            logger?.warn?.(`buddy animator frame failed (${consecutiveFailures} consecutive): ${errorReason(error)}`);
          }
        }
      }
      await sleep(intervalMs);
    }
  }

  return {
    start() {
      if (!running) {
        running = true;
        loop().catch((error) => {
          logger?.warn?.(`buddy animator loop failed: ${errorReason(error)}`);
          running = false;
        });
      }
    },
    stop() { running = false; },
    pause() { pauseDepth += 1; },
    resume() { pauseDepth = Math.max(0, pauseDepth - 1); },
  };
}

function errorReason(error) {
  return error?.message ? error.message : "error";
}
