// Derives the current stage of an image build from its status and Docker output.
// Pure function, so it can be tested without Docker or the database.
export function progressOf(status, log = '') {
  if (status === 'succeeded') return { key: 'done', percent: 100, detail: '' };
  if (status === 'failed') return { key: 'failed', percent: 0, detail: '' };
  if (/naming to|Successfully tagged|writing image/.test(log)) return { key: 'tagging', percent: 95, detail: '' };
  const steps = [...String(log).matchAll(/(?:Step |\[)(\d+)\/(\d+)/g)];
  if (steps.length) {
    const [, n, total] = steps[steps.length - 1];
    const percent = Math.min(90, Math.round(10 + (80 * Number(n)) / Number(total)));
    return { key: 'building', percent, detail: `step ${n} of ${total}` };
  }
  return { key: 'starting', percent: 5, detail: '' };
}
