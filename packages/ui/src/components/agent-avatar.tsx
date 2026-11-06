import { brand } from "../tokens";

/**
 * The assistant's face: a friendly robot head (white face, navy visor,
 * green eyes, an antenna with a green tip) drawn for a navy circle. Colours
 * are the brand's own, so it reads the same in light and dark mode.
 * Decorative: the button or heading next to it carries the name. The eyes
 * blink (`.c-agent-eyes`), which reduced-motion settings turn off.
 */
export function AgentAvatar({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      {/* Antenna */}
      <path d="M24 15V9.5" stroke={brand.white} strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="24" cy="8" r="2.9" fill={brand.green} />
      {/* Ears */}
      <rect x="6.5" y="21.5" width="4" height="9" rx="2" fill={brand.white} />
      <rect x="37.5" y="21.5" width="4" height="9" rx="2" fill={brand.white} />
      {/* Head and visor */}
      <rect x="10" y="15" width="28" height="23" rx="9" fill={brand.white} />
      <rect x="13.5" y="19.5" width="21" height="12" rx="6" fill={brand.navy} />
      <g className="c-agent-eyes">
        <circle cx="19.5" cy="25.5" r="2.4" fill={brand.green} />
        <circle cx="28.5" cy="25.5" r="2.4" fill={brand.green} />
      </g>
      {/* Smile */}
      <path d="M21 34.2q3 1.6 6 0" stroke={brand.navy} strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
