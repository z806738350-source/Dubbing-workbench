import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './store.mjs';

export function createLocalPool(limit = 1) {
  let active = 0, peak = 0;
  const queue = [], waiters = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const { work, resolve, reject } = queue.shift(); active++; peak = Math.max(peak, active);
      const finish = () => { active--; pump(); if (!active && !queue.length) for (const wake of waiters.splice(0)) wake(); };
      Promise.resolve().then(work).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    }
  };
  return { run: work => new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); pump(); }),
    get active() { return active; }, get queued() { return queue.length; }, get peak() { return peak; },
    drain: () => active || queue.length ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve() };
}

export function createFairPicker() {
  let previous = '', interactiveStreak = 0;
  const cursors = { foreground: '', background: '' };
  return jobs => {
    if (!jobs.length) return null;
    const interactive = j => ['voice-test', 'voice-create'].includes(j.kind);
    if (!previous) { previous = jobs[0].id; interactiveStreak = interactive(jobs[0]) ? 1 : 0; cursors[interactive(jobs[0]) ? 'foreground' : 'background'] = previous; return jobs[0]; }
    const waiting = jobs.filter(j => !j.inFlight), allBackground = jobs.filter(j => !interactive(j));
    // A long in-flight paragraph must not let a stream of new interactive jobs
    // bypass the two-interactive/one-background rule for its waiting siblings.
    const pool = interactiveStreak >= 2 && allBackground.length ? allBackground : waiting.length ? waiting : jobs;
    const foreground = pool.filter(interactive), background = pool.filter(j => !interactive(j));
    const candidates = foreground.length && (interactiveStreak < 2 || !background.length) ? foreground : background.length ? background : foreground;
    const category = interactive(candidates[0]) ? 'foreground' : 'background';
    const index = candidates.findIndex(j => j.id === cursors[category]), selected = candidates[(index + 1) % candidates.length];
    previous = selected.id; cursors[category] = selected.id; interactiveStreak = interactive(selected) ? interactiveStreak + 1 : 0;
    return selected;
  };
}

export function referenceVersion(s) { return [s.size, s.mtimeMs, s.ctimeMs, s.ino].join(':'); }
export function createReferenceCache(directory, local, inspectReference, maxBytes = 180 * 1024 * 1024) {
  const entries = new Map(), paths = new Map(), versions = new Map(), reading = new Map();
  let bytes = 0, peak = 0;
  async function acquire(voice) {
    const file = join(directory, voice.path), stamp = referenceVersion(await stat(file)), key = `${file}:${stamp}`;
    reading.set(voice.id, (reading.get(voice.id) || 0) + 1);
    let entry;
    try {
      let pending = entries.has(versions.get(key)) ? Promise.resolve(entries.get(versions.get(key))) : paths.get(key);
      if (!pending) {
        pending = local.run(async () => {
          await inspectReference(voice);
          const data = await readFile(file);
          if (!data.length || data.length > 10 * 1024 * 1024 || referenceVersion(await stat(file)) !== stamp) fail('参考声音读取期间变化或超出10MB，本次未发送', 409);
          const hash = createHash('sha256').update(data).digest('hex');
          let cached = entries.get(hash);
          if (!cached) {
            const text = data.toString('base64');
            for (const [id, candidate] of entries) {
              if (bytes + text.length <= maxBytes) break;
              if (!candidate.refs) { entries.delete(id); bytes -= candidate.text.length; }
            }
            if (bytes + text.length > maxBytes) fail('参考缓存已达到内存上限，本条未发送', 503);
            cached = { text, hash, bytes: data.length, refs: 0 };
            entries.set(hash, cached); bytes += text.length; peak = Math.max(peak, bytes);
          }
          versions.set(key, hash);
          if (versions.size > 256) versions.delete(versions.keys().next().value);
          return cached;
        });
        paths.set(key, pending);
        pending.finally(() => paths.delete(key)).catch(() => {});
      }
      entry = await pending; entry.refs++;
      return { payload: { audio_data: entry.text }, asset: { voiceId: voice.id, contentHash: entry.hash, bytes: entry.bytes, path: voice.path, fileVersion: stamp },
        release() { entry.refs--; } };
    } finally {
      const count = reading.get(voice.id) - 1;
      if (count) reading.set(voice.id, count); else reading.delete(voice.id);
    }
  }
  return { acquire, reading, get bytes() { return bytes; }, get peak() { return peak; } };
}

// New plans carry a target epoch. Legacy rows retain the original insertion-order
// rule because their generation order cannot be reconstructed from timestamps.
export function hasNewerAttempt(attempts, current, matches) {
  const at = attempts.findIndex(a => a.id === current.id);
  return attempts.some((a, index) => a.id !== current.id && matches(a) &&
    (Number.isSafeInteger(current.generationEpoch) && current.generationEpoch > 0 && Number.isSafeInteger(a.generationEpoch) && a.generationEpoch > 0
      ? a.generationEpoch > current.generationEpoch : index > at));
}
