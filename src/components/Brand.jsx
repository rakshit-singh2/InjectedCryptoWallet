import { useId } from 'react';
import { brand } from '../theme';

/** The Rakshit Wallet "R" mark. Same artwork as public/logo.svg; ids are unique per instance. */
export function BrandMark({ size = 40, title = brand.name }) {
  const id = useId().replace(/:/g, '');
  const bg = `rw-bg-${id}`;
  const leg = `rw-leg-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" role="img" aria-label={title}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#19b46a" />
          <stop offset="1" stopColor="#07542f" />
        </linearGradient>
        <linearGradient id={leg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb547" />
          <stop offset="1" stopColor="#f2621a" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="30" fill={`url(#${bg})`} />
      <path d="M0 96C30 84 70 84 128 104V128H0Z" fill="#000" opacity="0.1" />
      <g transform="translate(10 0) skewX(-10)" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M42 98V31h27a19.5 19.5 0 0 1 0 39H42" stroke="#fff" strokeWidth="13" />
        <path d="M62 70l29 28" stroke={`url(#${leg})`} strokeWidth="13" />
      </g>
      <circle cx="99" cy="30" r="7" fill={`url(#${leg})`} />
    </svg>
  );
}

/** Logo + wordmark. `size` is the mark's height in px. */
export function BrandLogo({ size = 32 }) {
  return (
    <span className="brand-logo" data-testid="brand-logo">
      <BrandMark size={size} />
      <span className="brand-wordmark" style={{ fontSize: Math.round(size * 0.62) }}>
        <span className="brand-wordmark-primary">Rakshit</span>
        <span className="brand-wordmark-accent">Wallet</span>
      </span>
    </span>
  );
}
