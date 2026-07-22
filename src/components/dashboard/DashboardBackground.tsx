// Purely decorative page background for the Dashboards list — an
// enterprise-analytics-style backdrop (navy base, soft glows, faint map
// dots, network lines, blurred chart silhouettes) that sits behind the
// real content and never carries any information of its own. Dark-theme
// only: the flat navy base and glow tints are hand-tuned against the dark
// palette and would just look like a smudge on the light theme's white
// surfaces, so it's hidden there via `dark:block hidden` rather than
// adapting — nothing here is interactive or informative enough to need a
// light-mode equivalent.
export function DashboardBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden dark:block"
      style={{ backgroundColor: '#161b24' }}
    >
      {/* Soft color glows — blurred blobs, not hard gradients, so they read
          as ambient light rather than shapes. */}
      <div className="absolute -bottom-24 -left-32 size-[520px] rounded-full bg-red-600/10 blur-[110px]" />
      <div className="absolute -top-32 -right-20 size-[480px] rounded-full bg-blue-600/10 blur-[110px]" />
      <div className="absolute top-1/3 left-1/2 size-[420px] rounded-full bg-purple-600/[0.08] blur-[110px]" />

      {/* Illustration layer: map dots, network lines, particles, blurred
          chart silhouettes. Kept at very low opacity as one group, then
          masked so it fades out toward the page edges instead of ending
          in a hard rectangle. */}
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.07]"
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
            id="ll-bg-blur-sm"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter
            id="ll-bg-blur-lg"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="14" />
          </filter>
        </defs>

        {/* Faint world-map dot cluster, left third of the canvas. */}
        <g fill="#8fb4ff">
          {WORLD_MAP_DOTS.map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r={i % 5 === 0 ? 2.2 : 1.4} />
          ))}
        </g>

        {/* Network connection lines with node points, center-right. */}
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

        {/* Blurred chart silhouettes — suggested widgets, never legible. */}
        <g filter="url(#ll-bg-blur-lg)">
          {/* Donut chart silhouette. */}
          <circle
            cx="1260"
            cy="620"
            r="90"
            fill="none"
            stroke="#f87171"
            strokeWidth="26"
            strokeDasharray="330 240"
            transform="rotate(-40 1260 620)"
          />
          {/* Bar chart silhouette. */}
          {BAR_CHART_BARS.map(([x, h], i) => (
            <rect
              key={i}
              x={x}
              y={780 - h}
              width="26"
              height={h}
              fill="#8fb4ff"
            />
          ))}
          {/* Line chart silhouette. */}
          <polyline
            points="980,300 1040,260 1090,290 1140,220 1190,250 1240,190 1290,225"
            fill="none"
            stroke="#f87171"
            strokeWidth="4"
          />
        </g>

        {/* Glassmorphism panel hints — softly rounded, near-invisible fills
            suggesting blurred dashboard widgets sitting in the distance. */}
        <g filter="url(#ll-bg-blur-sm)">
          <rect
            x="60"
            y="560"
            width="300"
            height="180"
            rx="24"
            fill="#ffffff"
            fillOpacity="0.05"
            stroke="#ffffff"
            strokeOpacity="0.08"
          />
          <rect
            x="1180"
            y="80"
            width="260"
            height="160"
            rx="24"
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

// Hand-placed rather than randomly generated so the layout is stable
// across renders and reads as an intentional (if abstract) map/graph
// instead of visual noise.
const WORLD_MAP_DOTS: Array<[number, number]> = [
  [90, 180],
  [130, 170],
  [170, 185],
  [210, 175],
  [250, 190],
  [110, 220],
  [150, 230],
  [190, 220],
  [230, 235],
  [270, 225],
  [80, 260],
  [120, 270],
  [160, 260],
  [200, 275],
  [240, 265],
  [280, 280],
  [100, 310],
  [140, 320],
  [180, 305],
  [220, 320],
  [260, 310],
  [90, 350],
  [130, 360],
  [170, 345],
  [210, 360],
  [250, 350],
  [290, 340],
  [110, 400],
  [150, 410],
  [190, 395],
  [230, 405],
  [270, 415],
  [70, 440],
  [130, 450],
  [170, 440],
  [210, 455],
  [250, 445],
  [180, 490],
  [220, 500],
  [140, 500],
  [100, 480],
  [260, 480],
]

const NETWORK_NODES: Array<[number, number]> = [
  [900, 140],
  [1020, 100],
  [1140, 160],
  [1000, 230],
  [1120, 260],
  [960, 340],
  [1080, 380],
  [1220, 320],
]

const NETWORK_EDGES: Array<[number, number, number, number]> = [
  [900, 140, 1020, 100],
  [1020, 100, 1140, 160],
  [1020, 100, 1000, 230],
  [1000, 230, 1120, 260],
  [1140, 160, 1120, 260],
  [1000, 230, 960, 340],
  [1120, 260, 1080, 380],
  [1080, 380, 960, 340],
  [1120, 260, 1220, 320],
]

const PARTICLES: Array<[number, number, number]> = [
  [400, 120, 1.5],
  [520, 200, 1],
  [650, 90, 1.8],
  [770, 160, 1.2],
  [850, 60, 1],
  [340, 500, 1.4],
  [480, 620, 1],
  [600, 700, 1.6],
  [730, 640, 1.1],
  [860, 720, 1.3],
  [1300, 200, 1.5],
  [1420, 140, 1],
  [1500, 300, 1.2],
  [1350, 480, 1],
  [1460, 560, 1.4],
  [1550, 700, 1.1],
  [50, 700, 1.2],
  [700, 40, 1],
  [1550, 60, 1.3],
  [950, 800, 1.1],
]

const BAR_CHART_BARS: Array<[number, number]> = [
  [1400, 60],
  [1436, 100],
  [1472, 80],
  [1508, 130],
  [1544, 90],
]
