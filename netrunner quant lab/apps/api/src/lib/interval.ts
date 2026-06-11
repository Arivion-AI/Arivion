const intervalMinutes: Record<string, number> = {
  "1": 1,
  "3": 3,
  "5": 5,
  "15": 15,
  "30": 30,
  "60": 60,
  "120": 120,
  "240": 240,
  "360": 360,
  "720": 720,
  "D": 1440,
  "1d": 1440,
  "W": 10080,
  "1w": 10080,
  "1h": 60,
  "4h": 240
};

export function intervalToMs(interval: string): number {
  const mins = intervalMinutes[interval];
  if (!mins) {
    throw new Error(`Unsupported interval: ${interval}`);
  }
  return mins * 60_000;
}

export function alignTsToInterval(tsMs: number, interval: string): number {
  const step = intervalToMs(interval);
  return Math.floor(tsMs / step) * step;
}
