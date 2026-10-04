// clock.ts – injectable time source for the bot. Production code reads time only through a Clock,
// so tests and the downtime replay can control it (including moving it backwards).

export interface Clock {
  now(): number; // epoch milliseconds
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  private t: number;

  constructor(startMs: number) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  // Unlike advance(), may move time backwards: simulates an NTP step or a resume from sleep.
  set(ms: number): void {
    this.t = ms;
  }
}
