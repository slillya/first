// Small stroke icons, drawn on a 24px grid.
const PATHS: Record<string, string> = {
  chevron: "M6 9l6 6 6-6",
  tools: "M14.5 5.5a4 4 0 0 0-5.2 5.2L4 16l4 4 5.3-5.3a4 4 0 0 0 5.2-5.2L16 12l-2.5-.5L13 9l2.5-2.5z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z",
  send: "M12 19V5M6 11l6-6 6 6",
  stop: "M7 7h10v10H7z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  undo: "M9 7L4 12l5 5M4 12h10a5 5 0 0 1 0 10h-2",
  redo: "M15 7l5 5-5 5M20 12H10a5 5 0 0 0 0 10h2",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeOff: "M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 6.4C3.6 8.2 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  ink: "M3 17c3-6 5-9 7-9s1 6 3 6 3-7 5-7 2 3 3 5",
  line: "M5 18L10 7l5 8 4-9M5 18h.01M10 7h.01M15 15h.01M19 6h.01",
  rect: "M4 7h16v10H4z",
  circle: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
  select: "M6 3l12 9-5 1 3 6-2.5 1.2-3-6L7 18z",
  erase: "M4 16l9-9 6 6-6 6H8zM13 19h7M9.5 10.5l6 6",
  wand: "M5 19L15 9M14 6l.8 2.2L17 9l-2.2.8L14 12l-.8-2.2L11 9l2.2-.8zM19 13l.5 1.5L21 15l-1.5.5L19 17l-.5-1.5L17 15l1.5-.5z",
  sketch: "M4 20l1-4L16 5l3 3L8 19zM14 7l3 3M3 21h18",
  extrude: "M5 14l7 3 7-3M5 14v4l7 3 7-3v-4M12 13V3M8.5 6.5L12 3l3.5 3.5",
  cut: "M4 8l8-3 8 3v9l-8 3-8-3zM9 10.5l3 1 3-1v4l-3 1-3-1z",
  revolve: "M12 3v18M12 7c4 0 7 1.2 7 3s-3 3-7 3M19 10v5c0 1.8-3 3-7 3M16 4.5a8 8 0 0 1 3 2.5M19 4v3h-3",
  fillet: "M4 20V11a7 7 0 0 1 7-7h9M4 20h16V4",
  chamfer: "M4 20v-9l7-7h9v16z",
  shell: "M4 8l8-3 8 3v9l-8 3-8-3zM7.5 10l4.5 1.5 4.5-1.5v5L12 16.5 7.5 15z",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9h6v6H9z",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  plus: "M12 5v14M5 12h14",
  plane: "M3 15l6-8h12l-6 8zM9 7v0",
  face: "M5 9l7-4 7 4-7 4zM5 9v6l7 4 7-4V9",
  history: "M4 6h16M4 12h10M4 18h13",
  warn: "M12 4l9 16H3zM12 10v4M12 17h.01",
  arc: "M4 18A14 14 0 0 1 20 8M4 18h.01M20 8h.01",
  dim: "M4 8v8M20 8v8M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3",
  coincident: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.5v1",
  horizontal: "M4 12h16M4 9v6M20 9v6",
  vertical: "M12 4v16M9 4h6M9 20h6",
  parallel: "M7 20L13 4M12 20l6-16",
  perpendicular: "M12 5v14M5 19h14",
  equal: "M6 9h12M6 15h12",
  tangent: "M4 6h16M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z",
  concentric: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  midpoint: "M4 16L20 8M12 12h.01M10 10l4 4",
  fix: "M12 3v10M8 7h8M5 13a7 7 0 0 0 14 0M12 20v-7",
  construction: "M4 20l3-3M10 14l3-3M16 8l3-3",
  angle: "M5 19h14M5 19L16 6M12 19a8 8 0 0 0-2.5-5.5",
  folder: "M3 7h6l2 2h10v10H3z",
  part: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9",
  assembly: "M3 8l5-3 5 3v6l-5 3-5-3zM13 12l4-2.5 4 2.5v5l-4 2.5-4-2.5M8 11v6",
  back: "M15 5l-7 7 7 7",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  files: "M4 5h7l2 2h7v12H4zM4 10h16",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  flip: "M7 4v16M17 4v16M7 8l-3 4 3 4M17 8l3 4-3 4",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
};

export function Icon({ name, size = 20, class: cls }: { name: string; size?: number; class?: string }) {
  return (
    <svg
      class={`icon ${cls ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? PATHS.cube} />
    </svg>
  );
}

export const FEATURE_ICON: Record<string, string> = {
  sketch: "sketch",
  plane: "plane",
  extrude: "extrude",
  revolve: "revolve",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
};
