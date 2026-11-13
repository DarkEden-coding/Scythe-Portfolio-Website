// The load bar over the cube while the first one comes in: its download, then getting it onto the
// GPU. The download is most of the wait, so it fills most of the bar.

const DOWNLOAD_SHARE = 0.85;

export class Loader {
  private readonly root: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly value: HTMLElement;
  private readonly detail: HTMLElement;
  private shown = 0;
  active = true;

  constructor(root: HTMLElement) {
    this.root = root;
    this.fill = root.querySelector('.loader__fill')!;
    this.value = root.querySelector('.loader__value')!;
    this.detail = root.querySelector('.loader__detail')!;
  }

  /** Bytes of the cube file received so far, of total (0 if unknown). */
  download(loaded: number, total: number): void {
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    this.detail.textContent = total ? `${mb(loaded)} of ${mb(total)} MB` : `${mb(loaded)} MB`;
    if (total) this.set(DOWNLOAD_SHARE * Math.min(1, loaded / total));
  }

  /** How far the cube is onto the GPU, 0..1. */
  upload(fraction: number): void {
    this.detail.textContent = 'building the voxels';
    this.set(DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * fraction);
  }

  done(): void {
    if (!this.active) return;
    this.active = false;
    this.set(1);
    this.root.classList.add('is-done');
    this.root.addEventListener('transitionend', () => { this.root.hidden = true; }, { once: true });
  }

  fail(): void {
    this.active = false;
    this.detail.textContent = 'could not load the cube';
    this.root.classList.add('is-failed');
  }

  private set(fraction: number): void {
    this.shown = Math.max(this.shown, fraction); // never goes backwards
    const percent = Math.round(this.shown * 100);
    this.fill.style.transform = `scaleX(${this.shown})`;
    this.value.textContent = `${percent}%`;
    this.root.setAttribute('aria-valuenow', String(percent));
  }
}
