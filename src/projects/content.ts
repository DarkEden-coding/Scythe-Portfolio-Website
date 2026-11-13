// Portfolio projects shown inside the cube. Content only; where each sits in the cube is in stations.ts.

export interface ProjectContent {
  id: string;          // kebab-case, unique, e.g. 'spaghetti-detection'
  name: string;        // display name, short (max ~22 chars)
  tab: string;         // very short tab label, max 12 chars, e.g. 'Spaghetti'
  tagline: string;     // one line, max 70 chars, says what it is
  summary: string;     // 2 sentences max, ~200-260 chars, what it does and the hard part
  highlights: string[]; // exactly 3 items, each max 60 chars: concrete technical facts (numbers, techniques, models)
  stack: string[];     // 3-5 tech names, e.g. ['Rust', 'PPO', 'Lua']
  year: string;        // e.g. '2026' or '2025–26'
  repo: string;        // https://github.com/DarkEden-coding/...
  live?: string;       // only if a deployed site really exists and responds
  stars?: number;      // only if > 0
  images: { src: string; alt: string; width: number; height: number }[]; // 0-2 images, src like '/projects/<id>-1.webp'
}

export const PROJECTS: ProjectContent[] = [
  {
    id: 'spaghetti-detection',
    name: 'Scythe Spaghetti',
    tab: 'Spaghetti',
    tagline: 'Self-hosted 3D printer failure detector for Klipper and Moonraker',
    summary:
      'Grabs a camera frame every 30 seconds during a print, checks it with a local YOLOv8 model or a vision decision model, and pauses the printer through Moonraker when it sees a failure. It installs next to Klipper on a Raspberry Pi with a setup wizard.',
    highlights: [
      'Local YOLOv8 on ONNX Runtime, about 7 s per frame on a Pi 4',
      'Decision model flags 7 failure types, including layer shift',
      'Blender scenes render synthetic failed prints with masks',
    ],
    stack: ['Python', 'YOLOv8', 'ONNX Runtime', 'Moonraker', 'Blender'],
    year: '2023–26',
    repo: 'https://github.com/DarkEden-coding/Scythe-Spaghetti-detection',
    stars: 9,
    images: [
      {
        src: '/projects/spaghetti-detection-1.webp',
        alt: 'Scythe setup wizard finding a printer on the network and showing a test frame from the bed camera',
        width: 1100,
        height: 900,
      },
      {
        src: '/projects/spaghetti-detection-2.webp',
        alt: 'Discord alert with a camera frame and a green box around detected spaghetti',
        width: 502,
        height: 490,
      },
    ],
  },
  {
    id: 'cone-perception',
    name: 'SAE Cone Perception',
    tab: 'Cones',
    tagline: 'Cone detection, pose and mapping for a driverless SAE race car',
    summary:
      'Finds cones and 8 keypoints per cone with a YOLO pose model, solves PnP for each cone position, and runs a cone-only SLAM over iPhone video to build a 3D cone map and camera path. Accuracy is measured on Blender renders with exact cone poses.',
    highlights: [
      'Pose mAP50-95 0.920, median keypoint error 1.14 px',
      'PnP median error 1.4 to 1.7% of range on synthetic renders',
      'SLAM on a simulated 225 m drive: 0.15 m trajectory error',
    ],
    stack: ['Python', 'Ultralytics YOLO', 'Swift', 'Three.js', 'Blender'],
    year: '2026',
    repo: 'https://github.com/DarkEden-coding/SAE-Cone-Stuff',
    images: [
      {
        src: '/projects/cone-perception-1.webp',
        alt: 'Phone frame of blue and yellow cones in a hallway, each boxed with its estimated distance in meters',
        width: 720,
        height: 1280,
      },
      {
        src: '/projects/cone-perception-2.webp',
        alt: 'Histograms of keypoint label offsets from the cone edge, real labels against synthetic ground truth, by class and by source',
        width: 1280,
        height: 336,
      },
    ],
  },
  {
    id: 'factorio-self-drive',
    name: 'Factorio Self-Drive',
    tab: 'Factorio',
    tagline: 'RL agents that drive the Factorio car and tank to a target',
    summary:
      'A Rust simulator of Factorio vehicle physics, calibrated against driving traces recorded in the real game, trains PPO policies on exported Nauvis maps. A small student distilled from the full policy then drives in pure Lua inside a Factorio mod.',
    highlights: [
      'Student net: 135 inputs, 13,312 multiply-adds per decision',
      '9 discrete actions, one decision every 4 game ticks',
      '0.987 SPL on standard holdout maps vs 0.929 for A*',
    ],
    stack: ['Rust', 'PyTorch', 'PPO', 'WebAssembly', 'Lua'],
    year: '2026',
    repo: 'https://github.com/DarkEden-coding/Factorio-Self-Drive',
    images: [],
  },
  {
    id: 'mutual',
    name: 'Mutual',
    tab: 'Mutual',
    tagline: 'Group scheduling poll, a free When2Meet alternative with no sign-up',
    summary:
      'Everyone paints the times they are free, or free if needed, and a live heatmap ranks the best meeting times as responses arrive. Slots are stored in the event timezone and converted to each viewer’s timezone in the browser.',
    highlights: [
      'Hono API on SQLite, live updates over Server-Sent Events',
      '12 themes, each with light and dark variants',
      'Rate limits per participant and per IP, IPv6 per /64',
    ],
    stack: ['TypeScript', 'React 19', 'Hono', 'SQLite', 'Docker'],
    year: '2026',
    repo: 'https://github.com/DarkEden-coding/Mutual',
    live: 'https://mutualmeet.app/',
    images: [
      {
        src: '/projects/mutual-1.webp',
        alt: 'Availability grid next to the group heatmap, with the ranked best times listed above',
        width: 1280,
        height: 800,
      },
      {
        src: '/projects/mutual-2.webp',
        alt: 'Theme picker open over the event page, showing classic and eccentric themes',
        width: 1280,
        height: 800,
      },
    ],
  },
  {
    id: 'slop-block',
    name: 'Slop Block',
    tab: 'Slop Block',
    tagline: 'GitHub App that makes unknown contributors prove they are human',
    summary:
      'Labels issues and pull requests from unknown authors and posts a link where they verify with GitHub OAuth and a CAPTCHA. Maintainers set per-repository policies and allowlists from a dashboard, and the whole stack self-hosts with Docker Compose.',
    highlights: [
      'Rust/Axum API checks X-Hub-Signature-256 on every webhook',
      'Supports Cloudflare Turnstile, hCaptcha and reCAPTCHA',
      'OAuth proves the verifier owns the account that opened it',
    ],
    stack: ['Rust', 'Axum', 'Next.js', 'PostgreSQL', 'Docker'],
    year: '2026',
    repo: 'https://github.com/DarkEden-coding/Slop-Block',
    images: [
      {
        src: '/projects/slop-block-1.webp',
        alt: 'GitHub issue where the bot added verification labels and posted a verification link',
        width: 958,
        height: 442,
      },
      {
        src: '/projects/slop-block-2.webp',
        alt: 'Verification complete page telling the contributor their account is now trusted for the repository',
        width: 810,
        height: 556,
      },
    ],
  },
  {
    id: 'swath',
    name: 'Swath',
    tab: 'Swath',
    tagline: 'Desktop workspace manager for terminals and coding agents',
    summary:
      'Keeps each project in its own workspace with named terminal views and split panes, backed by real PTY shells from a Rust backend. Layouts, split ratios and shell profiles persist in SQLite, and running processes are deliberately not restored.',
    highlights: [
      'Tauri 2 app with portable-pty shells and xterm.js panes',
      'Split layouts stored as a LayoutNode tree per view',
      'Native pane for the pi coding agent’s question prompts',
    ],
    stack: ['Rust', 'Tauri', 'React', 'TypeScript', 'SQLite'],
    year: '2026',
    repo: 'https://github.com/DarkEden-coding/Swath',
    images: [
      {
        src: '/projects/swath-1.webp',
        alt: 'Swath window with a project sidebar and two terminal panes split side by side',
        width: 1280,
        height: 720,
      },
    ],
  },
];
