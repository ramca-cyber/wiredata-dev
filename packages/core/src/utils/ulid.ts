/**
 * Zero-dependency sortable monotonic ULID generator
 * Uses Crockford's Base32 encoding (32 characters: 0-9, A-Z excluding I, L, O, U).
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = new Array(RANDOM_LEN).fill(0);

function getRandomValues(buf: Uint8Array): Uint8Array {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(buf);
  }
  // Node / fallback
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf;
}

export function generateULID(seedTime: number = Date.now()): string {
  let timeStr = '';
  let time = seedTime;

  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    timeStr = ENCODING.charAt(mod) + timeStr;
    time = (time - mod) / ENCODING_LEN;
  }

  // Handle monotonicity within same millisecond
  if (seedTime <= lastTime) {
    // Increment 16 base-32 digits from right to left
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      lastRandom[i] = (lastRandom[i] + 1) % ENCODING_LEN;
      if (lastRandom[i] !== 0) break;
    }
  } else {
    lastTime = seedTime;
    const randomBuf = new Uint8Array(RANDOM_LEN);
    getRandomValues(randomBuf);
    for (let i = 0; i < RANDOM_LEN; i++) {
      lastRandom[i] = randomBuf[i] % ENCODING_LEN;
    }
  }

  let randomStr = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    randomStr += ENCODING.charAt(lastRandom[i]);
  }

  return timeStr + randomStr;
}

export function isValidULID(id: string): boolean {
  if (typeof id !== 'string' || id.length !== 26) return false;
  return /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i.test(id);
}
