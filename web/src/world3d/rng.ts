export function hash32(a: number, b: number, c: number, salt: number): number {
  let h = mix((a | 0) ^ 0x9e3779b9);
  h = mix(h ^ (b | 0));
  h = mix(h ^ (c | 0));
  h = mix(h ^ (salt | 0));
  return h;
}

export function rand01(world: number, x: number, y: number, salt: number): number {
  return hash32(world, x, y, salt) / 4294967296;
}

export class SeededRandom {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

function mix(input: number): number {
  let h = input | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
