// Rakshit Wallet brand tokens. CSS variables in index.css mirror these values; keep them in sync.
export const brand = Object.freeze({
  name: 'Rakshit Wallet',
  green: '#0f8a4f',
  greenDark: '#07542f',
  greenLight: '#e7f6ee',
  orange: '#f2621a',
  orangeText: '#b8470c', // orange dark enough for text on white (WCAG AA)
  orangeLight: '#fff1e7',
  ink: '#10231a',
  muted: '#55665d',
  border: '#dbe6df',
  surface: '#ffffff',
  background: '#f4f8f5',
});

/** Ant Design theme: green is the primary action colour, orange the accent. */
export const antdTheme = {
  token: {
    colorPrimary: brand.green,
    colorInfo: brand.green,
    colorLink: brand.green,
    colorWarning: brand.orange,
    colorText: brand.ink,
    colorTextSecondary: brand.muted,
    colorBorder: brand.border,
    colorBgLayout: brand.background,
    borderRadius: 10,
    fontFamily: "Inter, 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif",
    fontSize: 14,
    controlHeight: 38,
  },
  components: {
    Button: { primaryShadow: '0 4px 12px rgba(15, 138, 79, 0.25)', fontWeight: 600 },
    Tabs: { itemSelectedColor: brand.green, inkBarColor: brand.orange, itemHoverColor: brand.greenDark },
    Card: { borderRadiusLG: 14 },
  },
};
