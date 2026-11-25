// Portfolio projects shown inside the cube. Content only; where each sits in the cube is in stations.ts.

// Screenshots go through Vite, so they ship under /assets/ with a content hash and cache for a year.
const SHOTS = import.meta.glob<string>('../assets/projects/*.webp', { eager: true, query: '?url', import: 'default' });

/** The built URL of src/assets/projects/<name>.webp. */
function shot(name: string): string {
  const url = SHOTS[`../assets/projects/${name}.webp`];
  if (!url) throw new Error(`no screenshot named ${name}`);
  return url;
}

export interface ProjectContent {
  id: string;          // kebab-case, unique, e.g. 'spaghetti-detection'
  name: string;        // display name, short (max ~22 chars)
  tab: string;         // very short tab label, max 12 chars, e.g. 'Spaghetti'
  tagline: string;     // one line, max 70 chars, says what it is
  summary: string;     // 2 sentences max, ~200-250 chars: first what it is for, in plain words, then how it works
  highlights: string[]; // exactly 3 items, each max 60 chars: concrete technical facts (numbers, techniques, models)
  stack: string[];     // 3-5 tech names, e.g. ['Rust', 'PPO', 'Lua']
  year: string;        // e.g. '2026' or '2025–26'
  repo: string;        // https://github.com/<owner>/<repo>
  live?: string;       // only if a deployed site really exists and responds
  stars?: number;      // only if > 0
  page?: string;       // path of its write-up page, if it has one, e.g. '/projects/eagleeye/'
  images: { src: string; alt: string; width: number; height: number }[]; // 0-3 images, src: shot('<id>-1') for src/assets/projects/<id>-1.webp
  thumbFocus?: string; // where the list's 16:9 crop of the first image centres (CSS object-position); default its top
}

export const PROJECTS: ProjectContent[] = [
  {
    id: 'eagleeye',
    name: 'EagleEye',
    tab: 'EagleEye',
    tagline: 'FRC robot vision: multi-camera AprilTag localization on a Pi',
    summary:
      'Tells an FRC robot where it is on the field by spotting AprilTags in its camera feeds. Teams build the camera pipelines as node graphs in a browser, and a Rust preprocessor predicts where tags will be so the detector only scans there.',
    highlights: [
      'Rust AprilTag detector, PnP refiner and outlier filter',
      'Object detection on CPU, CUDA or MemryX MX3 accelerators',
      'Benchmarked on 21,600 Blender frames of the 2026 field',
    ],
    stack: ['Python', 'Rust', 'OpenCV', 'Three.js', 'NetworkTables'],
    year: '2024–26',
    repo: 'https://github.com/Scythe-Engineering/EagleEye-Vision-System',
    page: '/projects/eagleeye/',
    stars: 5,
    images: [
      {
        src: shot('eagleeye-1'),
        alt: 'EagleEye 3D View tab showing the 2026 FRC field with the robot model at its reported pose',
        width: 1280,
        height: 800,
      },
      {
        src: shot('eagleeye-2'),
        alt: 'Pipeline editor running at 147 FPS, with per-node timings and the dashed camera pose feedback edge',
        width: 730,
        height: 340,
      },
      {
        src: shot('eagleeye-3'),
        alt: 'Pipeline Builder flow graph from Device Input through AprilTag detection and PnP to NetworkTables, with per-node timings',
        width: 1280,
        height: 710,
      },
    ],
  },
  {
    id: 'aerie',
    name: 'Aerie',
    tab: 'Aerie',
    tagline: 'Fab tracker for FRC robot parts, from CAD review to finished part',
    summary:
      'Tracks every part an FRC team builds, from CAD review through CNC or hand fabrication to done, so the shop always knows what to make next and who has it. Uploaded STEP files become 3D previews, rendered once in the browser and cached.',
    highlights: [
      'STEP files converted to GLB on upload with cascadio',
      'Three.js renders 8 views per part once, then caches them',
      'Pulls drawing PDFs from Onshape through its API',
    ],
    stack: ['Python', 'Flask', 'SQLAlchemy', 'Three.js', 'Vite'],
    year: '2025–26',
    repo: 'https://github.com/frc3322/Aerie-Part-Management',
    page: '/projects/aerie/',
    live: 'https://aeriedemo.scytheengineering.com/',
    stars: 1,
    images: [
      {
        src: shot('aerie-1'),
        alt: 'CNC tab with part cards for a gusset, an arm bracket and an intake plate, each with a rendered 3D view of its model',
        width: 1280,
        height: 550,
      },
      {
        src: shot('aerie-2'),
        alt: 'System statistics: completed and in-progress counts, average completion time and parts by workflow stage',
        width: 640,
        height: 673,
      },
    ],
  },
  {
    id: 'mutual',
    name: 'Mutual',
    tab: 'Mutual',
    tagline: 'Group scheduling poll, a free When2Meet alternative with no sign-up',
    summary:
      'A free When2Meet alternative: everyone paints when they’re free, and a live heatmap ranks the best meeting times as answers come in. No sign-up, and every time is stored in the event’s timezone and shown in each viewer’s own.',
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
        src: shot('mutual-1'),
        alt: 'Event page in dark mode: availability grid next to the group heatmap, with the ranked best times above',
        width: 1280,
        height: 900,
      },
      {
        src: shot('mutual-2'),
        alt: 'Group heatmap in the dark Terminal theme, hovering a slot to list who is available',
        width: 1280,
        height: 800,
      },
    ],
  },
  {
    id: 'spaghetti-detection',
    name: 'Scythe Spaghetti',
    tab: 'Spaghetti',
    tagline: 'Self-hosted 3D printer failure detector for Klipper and Moonraker',
    summary:
      'Stops a 3D print the moment it fails, before it wastes hours of filament. It runs next to Klipper on a Raspberry Pi, checks a camera frame every 30 seconds with a local YOLOv8 model, and pauses the printer through Moonraker.',
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
        src: shot('spaghetti-detection-1'),
        alt: 'Scythe setup wizard finding a printer on the network and showing a test frame from the bed camera',
        width: 1100,
        height: 900,
      },
      {
        src: shot('spaghetti-detection-2'),
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
      'Perception for a driverless SAE race car: it finds the track’s cones, works out where each one is, and maps them as the car drives. A YOLO pose model finds 8 keypoints per cone, PnP solves its position, and Blender renders check the accuracy.',
    highlights: [
      'Pose mAP50-95 0.920, median keypoint error 1.14 px',
      'PnP median error 1.4 to 1.7% of range on synthetic renders',
      'SLAM on a simulated 225 m drive: 0.15 m trajectory error',
    ],
    stack: ['Python', 'Ultralytics YOLO', 'Swift', 'Three.js', 'Blender'],
    year: '2026',
    repo: 'https://github.com/DarkEden-coding/SAE-Cone-Stuff',
    thumbFocus: 'center 27%',
    images: [
      {
        src: shot('cone-perception-1'),
        alt: 'Phone frame of blue and yellow cones in a hallway, each boxed with its estimated distance in meters',
        width: 720,
        height: 1280,
      },
      {
        src: shot('cone-perception-2'),
        alt: 'Histograms of keypoint label offsets from the cone edge, real labels against synthetic ground truth, by class and by source',
        width: 1280,
        height: 336,
      },
    ],
  },
  {
    id: 'slop-block',
    name: 'Slop Block',
    tab: 'Slop Block',
    tagline: 'GitHub App that makes unknown contributors prove they are human',
    summary:
      'Keeps AI-generated spam out of open-source repos by making unknown contributors prove they’re human. Their issues and pull requests get labelled and a link to a GitHub OAuth and CAPTCHA check, with rules set per repository.',
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
        src: shot('slop-block-1'),
        alt: 'GitHub issue where the bot added verification labels and posted a verification link',
        width: 958,
        height: 442,
      },
      {
        src: shot('slop-block-2'),
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
      'A desktop workspace for juggling terminals and coding agents across projects. Each project keeps its named terminal views and split panes of real shells, and layouts come back exactly as they were next session.',
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
        src: shot('swath-1'),
        alt: 'Swath window with a project sidebar and two terminal panes split side by side',
        width: 1280,
        height: 720,
      },
    ],
  },
];
