// Simple hand-drawn style pictures of everyday objects, as inline SVG.

const DRAWINGS = {
  pen: `
    <g transform="rotate(-35 30 30)">
      <rect x="25" y="6" width="10" height="40" rx="3" fill="#2f6fd6"/>
      <rect x="25" y="6" width="10" height="9" rx="3" fill="#1d4a99"/>
      <rect x="34" y="9" width="2.5" height="16" rx="1" fill="#1d4a99"/>
      <path d="M25 46 L35 46 L30 56 Z" fill="#f2d7a6"/>
      <path d="M28.5 53 L31.5 53 L30 56 Z" fill="#222"/>
    </g>`,
  potato: `
    <path d="M10 32 C8 18 22 10 34 12 C48 14 54 26 50 38 C46 50 30 52 20 48 C13 45 11 39 10 32 Z" fill="#c2924f" stroke="#8a6230" stroke-width="2"/>
    <circle cx="24" cy="24" r="1.8" fill="#8a6230"/><circle cx="38" cy="22" r="1.5" fill="#8a6230"/>
    <circle cx="33" cy="38" r="1.8" fill="#8a6230"/><circle cx="20" cy="38" r="1.3" fill="#8a6230"/>`,
  bean: `
    <path d="M14 26 C14 14 30 10 40 16 C50 22 50 36 42 42 C34 48 26 40 22 40 C16 40 14 34 14 26 Z" fill="#a23b2a" stroke="#6e2318" stroke-width="2"/>
    <path d="M22 22 C26 18 32 18 36 20" stroke="#e89a8a" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
  stone: `
    <path d="M8 38 C6 28 14 18 28 17 C42 16 52 24 52 34 C52 44 42 48 30 48 C18 48 10 46 8 38 Z" fill="#9aa0a6" stroke="#5f6368" stroke-width="2"/>
    <path d="M18 28 C22 24 28 23 32 24" stroke="#d7dbdf" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
  mango: `
    <path d="M14 34 C12 20 26 10 38 14 C50 18 52 34 44 44 C36 54 16 50 14 34 Z" fill="#f6b52e" stroke="#c77d12" stroke-width="2"/>
    <path d="M30 22 C38 20 42 28 40 34" stroke="#ffe08a" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>
    <path d="M36 14 C38 8 44 6 48 8 C46 12 42 14 36 14 Z" fill="#4c9a3b"/>`,
  egg: `
    <path d="M30 8 C42 8 50 28 48 38 C46 48 38 54 30 54 C22 54 14 48 12 38 C10 28 18 8 30 8 Z" fill="#fbf3e4" stroke="#c9b48f" stroke-width="2"/>
    <path d="M21 26 C22 20 25 16 28 14" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>`,
};

export function objectSvg(id, extraClass = "") {
  const body = DRAWINGS[id] || DRAWINGS.stone;
  return `<svg class="obj ${extraClass}" viewBox="0 0 60 60" aria-hidden="true">${body}</svg>`;
}

// A small child figure, used when sharing objects out in division problems.
export function childSvg(i) {
  const shirts = ["#e94f64", "#2f9e6b", "#7b5cd6", "#f08a24", "#1f8ac0", "#c2477e"];
  const shirt = shirts[i % shirts.length];
  return `<svg class="child" viewBox="0 0 60 60" aria-hidden="true">
    <circle cx="30" cy="16" r="10" fill="#8d5a3b"/>
    <circle cx="26.5" cy="15" r="1.4" fill="#222"/><circle cx="33.5" cy="15" r="1.4" fill="#222"/>
    <path d="M26 20 Q30 23 34 20" stroke="#222" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    <path d="M16 54 C16 36 22 28 30 28 C38 28 44 36 44 54 Z" fill="${shirt}"/>
  </svg>`;
}
