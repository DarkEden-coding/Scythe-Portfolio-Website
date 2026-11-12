// Chaos map of a planar triple pendulum, baked on an NVIDIA GPU. scripts/bake.mjs drives it.
//
// Every voxel is a pendulum released at rest, its three arm angles spread over ±π along x, y and z.
// Its chaos value is the finite-time Lyapunov exponent: how fast a tiny change to the start grows,
// in e-folds per second. The change is carried along as a derivative (dual numbers through RK4),
// which stays exact in float32, unlike running a second pendulum a hair away.
//
//   lyapunov bake    --n 320 --lengths 1,1,1 --masses 1,1,1 --gravity 9.81 --dt 0.01
//                    --horizons 5,10,20,40,60 --out master.f16 [--fp64]
//       Writes one float16 plane of n³ values per horizon (x fastest, then y, then z).
//   lyapunov pack    --in master.f16 --n 320 --plane 4 --max 4 --levels 64 --out cube.raw
//       One horizon as bytes: round(λ / max · (levels - 1)), clamped to 0..levels - 1.
//   lyapunov compare --a a.f16 --b b.f16 --n 64 --planes 5
//       Per horizon: mean |a - b| and correlation, to check float32 against float64.

#include <cuda_fp16.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#define CHECK(x) do { cudaError_t e = (x); if (e != cudaSuccess) { fprintf(stderr, "%s: %s\n", #x, cudaGetErrorString(e)); exit(1); } } while (0)

constexpr int MAX_HORIZONS = 8;
constexpr int RENORM_EVERY = 10; // steps between tangent renormalisations

// ---------- dual numbers: a value and its derivative along the tangent ----------

template <class R> struct Dual { R v, d; };
template <class R> __device__ inline Dual<R> operator+(Dual<R> a, Dual<R> b) { return {a.v + b.v, a.d + b.d}; }
template <class R> __device__ inline Dual<R> operator-(Dual<R> a, Dual<R> b) { return {a.v - b.v, a.d - b.d}; }
template <class R> __device__ inline Dual<R> operator-(Dual<R> a) { return {-a.v, -a.d}; }
template <class R> __device__ inline Dual<R> operator*(Dual<R> a, Dual<R> b) { return {a.v * b.v, a.v * b.d + a.d * b.v}; }
template <class R> __device__ inline Dual<R> operator*(R a, Dual<R> b) { return {a * b.v, a * b.d}; }
template <class R> __device__ inline Dual<R> operator/(Dual<R> a, Dual<R> b) { return {a.v / b.v, (a.d * b.v - a.v * b.d) / (b.v * b.v)}; }
template <class R> __device__ inline Dual<R> sin(Dual<R> a) { return {sin(a.v), cos(a.v) * a.d}; }
template <class R> __device__ inline Dual<R> cos(Dual<R> a) { return {cos(a.v), -sin(a.v) * a.d}; }
template <class R> __device__ inline Dual<R> operator+(Dual<R> a, R b) { return {a.v + b, a.d}; }
template <class R> __device__ inline Dual<R> operator-(R a, Dual<R> b) { return {a - b.v, -b.d}; }
template <class R> __device__ inline Dual<R> operator*(Dual<R> a, R b) { return {a.v * b, a.d * b}; }

// ---------- equations of motion: point masses on massless rods, angles from straight down ----------

template <class R> struct Coefficients {
  R a11, a22, a33; // diagonal of the mass matrix
  R b12, b13, b23; // off-diagonal terms, before the cos(θi - θj) factor
  R g1, g2, g3;    // gravity terms
};

template <class R> Coefficients<R> coefficients(const double l[3], const double m[3], double g) {
  double s1 = m[0] + m[1] + m[2], s2 = m[1] + m[2], s3 = m[2]; // mass at or below each link
  return {R(s1 * l[0] * l[0]), R(s2 * l[1] * l[1]), R(s3 * l[2] * l[2]),
          R(s2 * l[0] * l[1]), R(s3 * l[0] * l[2]), R(s3 * l[1] * l[2]),
          R(g * s1 * l[0]), R(g * s2 * l[1]), R(g * s3 * l[2])};
}

/** Angular accelerations from M(θ)·θ̈ = f(θ, ω), by Cramer's rule. s = [θ1, θ2, θ3, ω1, ω2, ω3]. */
template <class R, class T> __device__ inline void accelerate(const Coefficients<R>& k, const T* s, T* out) {
  T c12 = cos(s[0] - s[1]), c13 = cos(s[0] - s[2]), c23 = cos(s[1] - s[2]);
  T n12 = sin(s[0] - s[1]), n13 = sin(s[0] - s[2]), n23 = sin(s[1] - s[2]);
  T w1 = s[3] * s[3], w2 = s[4] * s[4], w3 = s[5] * s[5];
  T f1 = -(k.b12 * (n12 * w2) + k.b13 * (n13 * w3)) - k.g1 * sin(s[0]);
  T f2 = (k.b12 * (n12 * w1) - k.b23 * (n23 * w3)) - k.g2 * sin(s[1]);
  T f3 = (k.b13 * (n13 * w1) + k.b23 * (n23 * w2)) - k.g3 * sin(s[2]);
  T b = k.b12 * c12, c = k.b13 * c13, e = k.b23 * c23;
  T df = k.a22 * k.a33 - e * e, bf = k.a33 * b - e * c, be = b * e - k.a22 * c; // shared 2×2 minors
  T det = k.a11 * df - b * bf + c * be;
  out[0] = (f1 * df - b * (k.a33 * f2 - e * f3) + c * (e * f2 - k.a22 * f3)) / det;
  out[1] = (k.a11 * (k.a33 * f2 - e * f3) - f1 * bf + c * (b * f3 - c * f2)) / det;
  out[2] = (k.a11 * (k.a22 * f3 - e * f2) - b * (b * f3 - c * f2) + f1 * be) / det;
}

template <class R, class T> __device__ inline void rk4(T* s, R dt, const Coefficients<R>& k) {
  T k1[3], k2[3], k3[3], k4[3], t[6], v[3], u[3];
  R h = dt / 2;
  accelerate(k, s, k1);
  for (int i = 0; i < 3; i++) { t[i] = s[i] + h * s[3 + i]; v[i] = s[3 + i] + h * k1[i]; t[3 + i] = v[i]; }
  accelerate(k, t, k2);
  for (int i = 0; i < 3; i++) { t[i] = s[i] + h * v[i]; u[i] = s[3 + i] + h * k2[i]; t[3 + i] = u[i]; }
  accelerate(k, t, k3);
  for (int i = 0; i < 3; i++) { t[i] = s[i] + dt * u[i]; t[3 + i] = s[3 + i] + dt * k3[i]; }
  accelerate(k, t, k4);
  R sixth = dt / 6;
  for (int i = 0; i < 3; i++) {
    T x = t[3 + i];
    s[i] = s[i] + sixth * (s[3 + i] + R(2) * v[i] + R(2) * u[i] + x);
    s[3 + i] = s[3 + i] + sixth * (k1[i] + R(2) * k2[i] + R(2) * k3[i] + k4[i]);
  }
}

struct Job {
  int n, z0, slab;           // voxels with z in [z0, z0 + slab)
  int horizons;
  int steps[MAX_HORIZONS];   // horizon in steps, ascending, multiples of RENORM_EVERY
};

template <class R> __global__ void lyapunov(Job job, Coefficients<R> k, R dt, __half* out) {
  const int n = job.n, perSlab = n * n * job.slab;
  int id = blockIdx.x * blockDim.x + threadIdx.x;
  if (id >= perSlab) return;
  int x = id % n, y = (id / n) % n, z = job.z0 + id / (n * n);
  const R pi = R(3.14159265358979323846);
  auto angle = [&](int i) { return (R(2) * (R(i) + R(0.5)) / R(n) - R(1)) * pi; };

  // Released at rest; the tangent starts along all six directions equally.
  R start[6] = {angle(x), angle(y), angle(z), 0, 0, 0};
  Dual<R> s[6];
  for (int i = 0; i < 6; i++) s[i] = {start[i], R(0.40824829046386301637)}; // 1/√6

  R logGrowth = 0;
  int h = 0;
  for (int step = 1; step <= job.steps[job.horizons - 1]; step++) {
    rk4(s, dt, k);
    if (step % RENORM_EVERY) continue;
    R norm = 0;
    for (int i = 0; i < 6; i++) norm += s[i].d * s[i].d;
    norm = sqrt(norm);
    logGrowth += log(norm);
    for (int i = 0; i < 6; i++) s[i].d /= norm;
    if (step == job.steps[h]) {
      out[size_t(h) * perSlab + id] = __float2half(float(logGrowth / (R(step) * dt)));
      h++;
    }
  }
}

// ---------- host ----------

using Args = std::map<std::string, std::string>;

static Args parse(int argc, char** argv) {
  Args a;
  for (int i = 2; i < argc; i++) {
    if (strncmp(argv[i], "--", 2)) continue;
    bool flag = i + 1 == argc || !strncmp(argv[i + 1], "--", 2);
    std::string key = argv[i] + 2;
    a[key] = flag ? "1" : argv[++i];
  }
  return a;
}

static std::vector<double> list(const std::string& s) {
  std::vector<double> v;
  for (const char* p = s.c_str(); *p;) { char* end; v.push_back(strtod(p, &end)); p = *end ? end + 1 : end; }
  return v;
}

static const std::string& need(const Args& a, const char* key) {
  auto it = a.find(key);
  if (it == a.end()) { fprintf(stderr, "missing --%s\n", key); exit(2); }
  return it->second;
}

template <class R> static void bake(const Args& a) {
  int n = atoi(need(a, "n").c_str());
  std::vector<double> l = list(need(a, "lengths")), m = list(need(a, "masses")), horizons = list(need(a, "horizons"));
  double g = atof(need(a, "gravity").c_str()), dt = atof(need(a, "dt").c_str());
  if (l.size() != 3 || m.size() != 3 || horizons.empty() || horizons.size() > MAX_HORIZONS) { fprintf(stderr, "bad arguments\n"); exit(2); }

  Job job{n, 0, 0, int(horizons.size()), {}};
  for (int i = 0; i < job.horizons; i++) {
    job.steps[i] = int(lround(horizons[i] / dt / RENORM_EVERY)) * RENORM_EVERY;
    if (i > 0 && job.steps[i] <= job.steps[i - 1]) { fprintf(stderr, "horizons must ascend\n"); exit(2); }
  }
  // Short launches keep the desktop responsive and stay clear of display watchdogs.
  job.slab = std::max(1, (1 << 17) / (n * n));

  FILE* f = fopen(need(a, "out").c_str(), "wb");
  if (!f) { perror("out"); exit(1); }
  size_t plane = size_t(n) * n * n;
  std::vector<__half> host(size_t(job.horizons) * n * n * job.slab);
  __half* dev;
  CHECK(cudaMalloc(&dev, host.size() * sizeof(__half)));
  Coefficients<R> k = coefficients<R>(l.data(), m.data(), g);

  cudaEvent_t t0, t1;
  cudaEventCreate(&t0); cudaEventCreate(&t1); cudaEventRecord(t0);
  for (job.z0 = 0; job.z0 < n; job.z0 += job.slab) {
    Job j = job;
    j.slab = std::min(job.slab, n - job.z0);
    int count = n * n * j.slab;
    lyapunov<R><<<(count + 127) / 128, 128>>>(j, k, R(dt), dev);
    CHECK(cudaGetLastError());
    CHECK(cudaMemcpy(host.data(), dev, size_t(j.horizons) * count * sizeof(__half), cudaMemcpyDeviceToHost));
    for (int h = 0; h < j.horizons; h++) {
      fseeko(f, off_t((h * plane + size_t(job.z0) * n * n) * sizeof(__half)), SEEK_SET);
      fwrite(host.data() + size_t(h) * count, sizeof(__half), count, f);
    }
    fprintf(stderr, "\rz %d/%d", job.z0 + j.slab, n);
  }
  cudaEventRecord(t1); cudaEventSynchronize(t1);
  float ms; cudaEventElapsedTime(&ms, t0, t1);
  fprintf(stderr, "\r%d³ in %.1f s (%.2fM voxels/s)\n", n, ms / 1000, plane / ms / 1000);
  fclose(f);
  cudaFree(dev);
}

static std::vector<float> readPlane(const std::string& path, int n, int index) {
  size_t plane = size_t(n) * n * n;
  std::vector<__half> h(plane);
  FILE* f = fopen(path.c_str(), "rb");
  if (!f) { perror(path.c_str()); exit(1); }
  fseeko(f, off_t(index * plane * sizeof(__half)), SEEK_SET);
  if (fread(h.data(), sizeof(__half), plane, f) != plane) { fprintf(stderr, "%s: short read\n", path.c_str()); exit(1); }
  fclose(f);
  std::vector<float> v(plane);
  for (size_t i = 0; i < plane; i++) v[i] = __half2float(h[i]);
  return v;
}

static void pack(const Args& a) {
  int n = atoi(need(a, "n").c_str());
  double max = atof(need(a, "max").c_str()), top = atoi(need(a, "levels").c_str()) - 1;
  std::vector<float> v = readPlane(need(a, "in"), n, atoi(need(a, "plane").c_str()));
  std::vector<unsigned char> bytes(v.size());
  for (size_t i = 0; i < v.size(); i++) bytes[i] = (unsigned char)std::round(std::fmin(1.0, std::fmax(0.0, v[i] / max)) * top);
  FILE* f = fopen(need(a, "out").c_str(), "wb");
  if (!f || fwrite(bytes.data(), 1, bytes.size(), f) != bytes.size()) { perror("out"); exit(1); }
  fclose(f);
}

static void compare(const Args& a) {
  int n = atoi(need(a, "n").c_str()), planes = atoi(need(a, "planes").c_str());
  for (int p = 0; p < planes; p++) {
    std::vector<float> x = readPlane(need(a, "a"), n, p), y = readPlane(need(a, "b"), n, p);
    double sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, diff = 0;
    for (size_t i = 0; i < x.size(); i++) {
      sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i]; diff += fabs(x[i] - y[i]);
    }
    double c = double(x.size());
    double r = (sxy - sx * sy / c) / sqrt((sxx - sx * sx / c) * (syy - sy * sy / c));
    printf("plane %d: mean a %.3f, mean b %.3f, mean |a-b| %.3f, correlation %.4f\n", p, sx / c, sy / c, diff / c, r);
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { fprintf(stderr, "usage: lyapunov bake|pack|compare ...\n"); return 2; }
  Args a = parse(argc, argv);
  std::string mode = argv[1];
  if (mode == "bake") a.count("fp64") ? bake<double>(a) : bake<float>(a);
  else if (mode == "pack") pack(a);
  else if (mode == "compare") compare(a);
  else { fprintf(stderr, "unknown mode %s\n", mode.c_str()); return 2; }
  return 0;
}
