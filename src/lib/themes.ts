export interface ThemePalette {
  name: string;
  label: string;
  previewPrimary: string;  // color CSS directo para el swatch (hex o oklch)
  vars: Record<string, string>;
}

// Cada tema sólo sobreescribe --primary, --primary-foreground y --ring.
// El resto (background, card, muted, etc.) hereda los valores base de global.css.
export const THEMES: ThemePalette[] = [
  {
    name: 'zinc',
    label: 'Zinc',
    previewPrimary: '#18181b',
    vars: {
      '--primary':            'oklch(0.205 0 0)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring':               'oklch(0.708 0 0)',
    },
  },
  {
    name: 'slate',
    label: 'Slate',
    previewPrimary: '#475569',
    vars: {
      '--primary':            'oklch(0.446 0.043 257.281)',
      '--primary-foreground': 'oklch(0.984 0.003 247.858)',
      '--ring':               'oklch(0.446 0.043 257.281)',
    },
  },
  {
    name: 'violet',
    label: 'Violet',
    previewPrimary: '#7c3aed',
    vars: {
      '--primary':            'oklch(0.606 0.25 292.717)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring':               'oklch(0.606 0.25 292.717)',
    },
  },
  {
    name: 'blue',
    label: 'Blue',
    previewPrimary: '#2563eb',
    vars: {
      '--primary':            'oklch(0.623 0.214 259.815)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring':               'oklch(0.623 0.214 259.815)',
    },
  },
  {
    name: 'green',
    label: 'Green',
    previewPrimary: '#16a34a',
    vars: {
      '--primary':            'oklch(0.696 0.17 162.48)',
      '--primary-foreground': 'oklch(0.145 0 0)',
      '--ring':               'oklch(0.696 0.17 162.48)',
    },
  },
  {
    name: 'orange',
    label: 'Orange',
    previewPrimary: '#ea580c',
    vars: {
      '--primary':            'oklch(0.705 0.191 60.382)',
      '--primary-foreground': 'oklch(0.145 0 0)',
      '--ring':               'oklch(0.705 0.191 60.382)',
    },
  },
  {
    name: 'rose',
    label: 'Rose',
    previewPrimary: '#e11d48',
    vars: {
      '--primary':            'oklch(0.638 0.203 359.81)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring':               'oklch(0.638 0.203 359.81)',
    },
  },
];

export const DEFAULT_THEME = 'zinc';

export function applyTheme(themeName: string) {
  const theme = THEMES.find(t => t.name === themeName);
  if (!theme) return;
  const root = document.documentElement;
  Object.entries(theme.vars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  localStorage.setItem('dl-color-theme', themeName);
}

export function getStoredTheme(): string {
  return localStorage.getItem('dl-color-theme') ?? DEFAULT_THEME;
}
