import { renderOnboarding } from "../render/onboarding.js";
import { CANDIDATES, OAK_LINES, TUTORIAL_PAGES } from "./onboarding-data.js";
import { SOUND } from "../transport/proto.js";

const HATCH_FRAMES = 12;
const HATCH_FRAME_MS = [220, 190, 190, 175, 175, 170, 170, 160, 160, 180, 160, 160];
const FIRST_BLACK_FRAME = 9;

export async function runOnboarding(io, { render = renderOnboarding } = {}) {
  // 大木开场白：逐页累积，每页等一次 KEY
  for (let page = 1; page <= OAK_LINES.length; page += 1) {
    await io.push(await render({ kind: "oak", lines: OAK_LINES.slice(0, page), page, total: OAK_LINES.length }));
    await waitKey(io);
  }

  // 选蛋：KEY short 切换、KEY long 确认
  let sel = 0;
  await io.push(await render({ kind: "choose", candidates: CANDIDATES, sel }));
  for (;;) {
    const b = await io.nextButton();
    if (b?.key === "KEY" && b.kind === "long") break;
    if (b?.key === "KEY") {
      sel = (sel + 1) % CANDIDATES.length;
      await io.push(await render({ kind: "choose", candidates: CANDIDATES, sel }));
    }
    // BOOT / 其它：忽略
  }
  const chosen = CANDIDATES[sel];

  // 孵化动画 + 音; 揭晓交给诞生屏
  for (let f = 0; f < HATCH_FRAMES; f += 1) {
    await io.push(await render({ kind: "hatch", frame: f, species: chosen.species }));
    // SND_EVOLVE 现在实际上就是孵化音：进化在 2026-07-31 有了自己的曲子，
    // 这里是唯一还在用它的地方，留着不动。
    if (f === FIRST_BLACK_FRAME) io.playSound(SOUND.EVOLVE);
    await io.delay(HATCH_FRAME_MS[f] ?? 170);
  }

  // 诞生
  await io.push(await render({ kind: "born", species: chosen.species, name: chosen.name }));
  await waitKey(io);

  return { species: chosen.species, name: chosen.name };
}

async function waitKey(io) {
  for (;;) {
    const b = await io.nextButton();
    if (b?.key === "KEY") return;
  }
}

export async function runTutorial(io, { render = renderOnboarding } = {}) {
  for (let i = 0; i < TUTORIAL_PAGES.length; i += 1) {
    await io.push(await render({
      kind: "oak",
      lines: TUTORIAL_PAGES[i],
      page: i + 1,
      total: TUTORIAL_PAGES.length,
    }));
    if (await waitKeyOrSkip(io)) return;
  }
}

// KEY 长按=跳过全部教程；KEY 短按=下一页；BOOT/其它忽略
async function waitKeyOrSkip(io) {
  for (;;) {
    const b = await io.nextButton();
    if (b?.key === "KEY" && b.kind === "long") return true;
    if (b?.key === "KEY") return false;
  }
}
