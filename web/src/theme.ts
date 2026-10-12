// Applies the university's primary colour to the whole UI via CSS variables.
export const DEFAULT_PRIMARY = '#1E5AA8';

export const PRESET_COLOURS = [
  '#1E5AA8', '#0B6E4F', '#7A1F5C', '#B42318', '#B54708', '#1D2939', '#5925DC', '#027A8F', '#4E5BA6', '#8E6C00',
];

function rgb(hex: string): [number, number, number] {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] || DEFAULT_PRIMARY.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

export const mix = (hex: string, target: number, amount: number) => toHex(rgb(hex).map((v) => v + (target - v) * amount));

export function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyTheme(primary?: string | null) {
  const p = /^#[0-9a-f]{6}$/i.test(primary || '') ? (primary as string) : DEFAULT_PRIMARY;
  const root = document.documentElement.style;
  root.setProperty('--primary', p);
  root.setProperty('--primary-strong', mix(p, 0, 0.18));
  root.setProperty('--primary-soft', mix(p, 255, 0.88));
  root.setProperty('--primary-softer', mix(p, 255, 0.95));
  root.setProperty('--on-primary', luminance(p) > 0.45 ? '#101828' : '#FFFFFF');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p);
}
