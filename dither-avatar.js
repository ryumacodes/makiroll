// Vanilla JavaScript port of Dither Kit's DitherAvatar 0.1.0 canvas renderer.
// Source: https://tripwire.sh/r/avatar.json (MIT)

const GRID = 8;
const CELL_PX = 4;
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
].map(row => row.map(value => (value + 0.5) / 16));
const animations = new WeakMap();

const clamp01 = value => value < 0 ? 0 : value > 1 ? 1 : value;

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function xorshift32(seed) {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function hueFill(hue) {
  const normalisedHue = ((hue % 360) + 360) % 360;
  const saturation = 0.85;
  const lightness = 0.58;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((normalisedHue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [red, green, blue] = normalisedHue < 60 ? [chroma, secondary, 0]
    : normalisedHue < 120 ? [secondary, chroma, 0]
      : normalisedHue < 180 ? [0, chroma, secondary]
        : normalisedHue < 240 ? [0, secondary, chroma]
          : normalisedHue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return [red, green, blue].map(channel => Math.round((channel + match) * 255));
}

function avatarModel(name) {
  const random = xorshift32(fnv1a(name));
  const bits = Array.from({ length: 32 }, () => random() < 0.5);
  const vertical = random() < 0.5;
  const hue = Math.floor(random() * 180) * 2;
  const halfDensity = Array.from({ length: 32 }, () => 0.55 + random() * 0.45);
  const on = new Array(GRID * GRID);
  const density = new Array(GRID * GRID);

  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      const sourceIndex = vertical
        ? Math.min(row, GRID - 1 - row) * GRID + column
        : row * (GRID / 2) + Math.min(column, GRID - 1 - column);
      on[row * GRID + column] = bits[sourceIndex];
      density[row * GRID + column] = halfDensity[sourceIndex];
    }
  }
  return { on, density, fill: hueFill(hue) };
}

export function renderDitherAvatar(canvas, name, { animate = true, duration = 600 } = {}) {
  const previousAnimation = animations.get(canvas);
  if (previousAnimation) cancelAnimationFrame(previousAnimation);

  const context = canvas.getContext('2d');
  if (!context) return;
  const pixels = GRID * CELL_PX;
  const model = avatarModel(String(name || 'Maki user'));
  canvas.width = pixels;
  canvas.height = pixels;

  const draw = progress => {
    context.clearRect(0, 0, pixels, pixels);
    for (let row = 0; row < GRID; row += 1) {
      for (let column = 0; column < GRID; column += 1) {
        if (!model.on[row * GRID + column]) continue;
        const start = BAYER4[row % 4][column % 4] * 0.7;
        const cellAlpha = clamp01((progress - start) / 0.3);
        if (cellAlpha <= 0) continue;
        const density = model.density[row * GRID + column];
        const base = 0.35 + 0.65 * density;
        for (let pixelY = 0; pixelY < CELL_PX; pixelY += 1) {
          for (let pixelX = 0; pixelX < CELL_PX; pixelX += 1) {
            const x = column * CELL_PX + pixelX;
            const y = row * CELL_PX + pixelY;
            const lit = density > BAYER4[y & 3][x & 3];
            const alpha = (lit ? base : base * 0.35) * cellAlpha;
            context.fillStyle = `rgba(${model.fill[0]},${model.fill[1]},${model.fill[2]},${alpha})`;
            context.fillRect(x, y, 1, 1);
          }
        }
      }
    }
  };

  if (!animate || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    draw(1);
    animations.delete(canvas);
    return;
  }

  const startedAt = performance.now();
  const tick = now => {
    const progress = clamp01((now - startedAt) / duration);
    draw(1 - (1 - progress) ** 3);
    if (progress < 1) animations.set(canvas, requestAnimationFrame(tick));
    else animations.delete(canvas);
  };
  animations.set(canvas, requestAnimationFrame(tick));
}
