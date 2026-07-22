// Purely decorative page background for the Users (admin) page — the same
// enterprise-analytics treatment as the Dashboards list background, but
// deliberately map/chart-free: this page is a management table, not a
// data-viz surface, so the illustration stays to generic geometry (grid,
// network, blurred circles, soft panels) rather than anything that reads as
// a specific widget. Dark-theme only, same reasoning as DashboardBackground:
// the flat navy base and glow tints are tuned against the dark palette and
// would just look like a smudge on light theme's white surfaces.
export function UsersBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden dark:block"
      style={{ backgroundColor: '#161b24' }}
    >
      {/* Soft color glows — blue top-left, purple bottom-right, per spec. */}
      <div className="absolute -top-28 -left-28 size-[460px] rounded-full bg-blue-600/10 blur-[50px]" />
      <div className="absolute -right-24 -bottom-28 size-[440px] rounded-full bg-purple-600/10 blur-[50px]" />

      {/* Illustration layer: grid, network lines, particles, blurred
          geometric circles, glassmorphism panels. One low-opacity group,
          masked so it fades out toward the page edges. */}
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.05]"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        style={{
          maskImage:
            'radial-gradient(ellipse 85% 85% at 50% 45%, black 45%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 85% 85% at 50% 45%, black 45%, transparent 100%)',
        }}
      >
        <defs>
          <filter
            id="ll-users-bg-blur"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="12" />
          </filter>
          <pattern
            id="ll-users-bg-grid"
            width="64"
            height="64"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 64 0 L 0 0 0 64"
              fill="none"
              stroke="#8fb4ff"
              strokeWidth="1"
            />
          </pattern>
        </defs>

        {/* Subtle grid, confined to a soft-edged rectangle rather than the
            full canvas so it reads as a texture, not a backdrop. */}
        <rect
          x="80"
          y="80"
          width="700"
          height="500"
          fill="url(#ll-users-bg-grid)"
        />

        {/* Network connection lines with node points. */}
        <g stroke="#8fb4ff" strokeWidth="1" fill="none">
          {NETWORK_EDGES.map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
        <g fill="#8fb4ff">
          {NETWORK_NODES.map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="2.5" />
          ))}
        </g>

        {/* Scattered floating particles across the whole canvas. */}
        <g fill="#ffffff">
          {PARTICLES.map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} />
          ))}
        </g>

        {/* Blurred geometric circles — plain rings, never a chart shape. */}
        <g filter="url(#ll-users-bg-blur)">
          <circle
            cx="1300"
            cy="220"
            r="140"
            fill="none"
            stroke="#8fb4ff"
            strokeWidth="30"
          />
          <circle
            cx="1180"
            cy="640"
            r="90"
            fill="none"
            stroke="#c084fc"
            strokeWidth="22"
          />
          <circle cx="1420" cy="560" r="46" fill="#8fb4ff" fillOpacity="0.5" />
        </g>

        {/* Glassmorphism panel hints — soft, near-invisible rounded panels
            suggesting abstract dashboard widgets in the distance. */}
        <g filter="url(#ll-users-bg-blur)">
          <rect
            x="1120"
            y="80"
            width="320"
            height="180"
            rx="28"
            fill="#ffffff"
            fillOpacity="0.05"
            stroke="#ffffff"
            strokeOpacity="0.08"
          />
          <rect
            x="60"
            y="640"
            width="280"
            height="170"
            rx="28"
            fill="#ffffff"
            fillOpacity="0.05"
            stroke="#ffffff"
            strokeOpacity="0.08"
          />
        </g>
      </svg>
    </div>
  )
}

// Hand-placed rather than randomly generated so the layout is stable across
// renders and reads as intentional, sparse geometry instead of noise.
const NETWORK_NODES: Array<[number, number]> = [
  [780, 200],
  [900, 150],
  [1020, 210],
  [860, 320],
  [980, 360],
  [740, 400],
  [1060, 460],
  [820, 520],
]

const NETWORK_EDGES: Array<[number, number, number, number]> = [
  [780, 200, 900, 150],
  [900, 150, 1020, 210],
  [900, 150, 860, 320],
  [860, 320, 980, 360],
  [1020, 210, 980, 360],
  [860, 320, 740, 400],
  [980, 360, 1060, 460],
  [740, 400, 820, 520],
]

const PARTICLES: Array<[number, number, number]> = [
  [200, 700, 1.4],
  [340, 760, 1],
  [460, 700, 1.6],
  [560, 800, 1.1],
  [120, 480, 1.2],
  [1450, 340, 1.3],
  [1500, 460, 1],
  [1350, 760, 1.2],
  [1220, 780, 1],
  [80, 200, 1.3],
  [600, 120, 1],
  [1550, 120, 1.2],
  [1500, 700, 1.1],
  [40, 620, 1],
  [950, 720, 1.3],
]
