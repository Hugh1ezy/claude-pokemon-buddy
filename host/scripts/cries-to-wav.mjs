// Render the device's sounds to WAV files on this machine, so they can be
// auditioned with no device, no speaker module and no reflash.
//
//   cd host && node scripts/cries-to-wav.mjs              # everything
//   cd host && node scripts/cries-to-wav.mjs evolve       # just the catch fanfare
//   cd host && node scripts/cries-to-wav.mjs bulbasaur pikachu
//
// Writes out/cries/<id>-<name>.wav and prints a manifest.
//
// This is a SAMPLE-FOR-SAMPLE port of firmware/main/main.cpp's `synth_tone`
// (square wave, 5ms attack, linear sweep, `1 - 0.7*frac` decay, amplitude 8000,
// 16kHz stereo with L=R). The point is that what you hear here is what the
// device will play, so the maths must not be "improved" -- if it diverges from
// the firmware the tool is worse than useless, because it would audition a sound
// that does not exist. Any change to synth_tone has to be mirrored here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AUDIO_SR = 16000;
const AUDIO_CH = 2;
const ATTACK = Math.floor((AUDIO_SR * 5) / 1000);
const AMPLITUDE = 8000;

// Duplicated from main.cpp's synth_all() -- the firmware defines these three
// inline rather than in seed/, so there is no shared source to read. Kept
// verbatim, ids matching SND_BUI / SND_EVOLVE / SND_HOUR.
const SYSTEM_SOUNDS = [
  { id: 0, name: "bui-idle", notes: [{ f0: 520, f1: 780, ms: 110 }, { f0: 0, f1: 0, ms: 40 }, { f0: 760, f1: 1150, ms: 130 }] },
  { id: 1, name: "evolve-fanfare", notes: [{ f0: 523, f1: 523, ms: 90 }, { f0: 659, f1: 659, ms: 90 }, { f0: 784, f1: 784, ms: 90 }, { f0: 1047, f1: 1047, ms: 240 }] },
  { id: 2, name: "hour-chime", notes: [{ f0: 880, f1: 880, ms: 90 }, { f0: 0, f1: 0, ms: 70 }, { f0: 880, f1: 880, ms: 90 }] },
];

export function synthTone(notes) {
  let frames = 0;
  for (const nt of notes) frames += Math.floor((AUDIO_SR * nt.ms) / 1000);
  const pcm = new Int16Array(frames * AUDIO_CH);

  let idx = 0;
  for (const nt of notes) {
    const n = Math.floor((AUDIO_SR * nt.ms) / 1000);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (nt.f0 > 0) {
        const frac = i / n;
        const freq = nt.f0 + (nt.f1 - nt.f0) * frac;
        phase += freq / AUDIO_SR;
        if (phase >= 1) phase -= 1;
        const sq = phase < 0.5 ? 1 : -1;
        const env = i < ATTACK ? i / ATTACK : 1 - 0.7 * frac;
        v = Math.trunc(sq * env * AMPLITUDE);
      }
      pcm[idx++] = v;   // L
      pcm[idx++] = v;   // R
    }
  }
  return pcm;
}

export function wavFile(pcm) {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);              // fmt chunk size
  buf.writeUInt16LE(1, 20);               // PCM
  buf.writeUInt16LE(AUDIO_CH, 22);
  buf.writeUInt32LE(AUDIO_SR, 24);
  buf.writeUInt32LE(AUDIO_SR * AUDIO_CH * 2, 28);  // byte rate
  buf.writeUInt16LE(AUDIO_CH * 2, 32);    // block align
  buf.writeUInt16LE(16, 34);              // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const data = JSON.parse(
    readFileSync(fileURLToPath(new URL("../seed/species-cries.json", import.meta.url)), "utf8"));
  const all = [
    ...SYSTEM_SOUNDS,
    ...data.species.map((s, i) => ({ id: data.soundBase + i, name: s.key, notes: s.notes })),
  ];

  const wanted = process.argv.slice(2).map((a) => a.toLowerCase());
  const picked = wanted.length === 0
    ? all
    : all.filter((s) => wanted.some((w) => s.name.toLowerCase().includes(w)));
  if (picked.length === 0) {
    console.error(`no sound matched ${wanted.join(" ")} -- names: ${all.map((s) => s.name).join(" ")}`);
    process.exit(2);
  }

  const dir = fileURLToPath(new URL("../out/cries/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const sound of picked) {
    const pcm = synthTone(sound.notes);
    const ms = sound.notes.reduce((t, n) => t + n.ms, 0);
    const file = `${dir}${String(sound.id).padStart(2, "0")}-${sound.name}.wav`;
    writeFileSync(file, wavFile(pcm));
    console.log(`id ${String(sound.id).padStart(2, " ")}  ${String(ms).padStart(4, " ")}ms  ${sound.name}`);
  }
  console.log(`\nwrote ${picked.length} wav(s) to out/cries/`);
}
