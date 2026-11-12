// Wiring for the simulation card: chaos threshold, segmented choices and the denoise filter.

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Wires the threshold slider. Returns a function that moves it without firing changes. */
export function bindThreshold(max: number, onScrub: (lambda: number) => void): (lambda: number) => void {
  const input = byId<HTMLInputElement>('threshold');
  input.max = String(max);
  input.addEventListener('input', () => onScrub(Number(input.value)));
  return lambda => { input.value = String(lambda); };
}

/** Wires a segmented radio group. Returns a function that selects one without firing changes. */
export function bindChoice<T extends string>(fieldsetId: string, initial: T | null, onChange: (value: T) => void): (value: T | null) => void {
  const inputs = [...document.querySelectorAll<HTMLInputElement>(`#${fieldsetId} input`)];
  for (const input of inputs) {
    input.addEventListener('change', () => { if (input.checked) onChange(input.value as T); });
  }
  const select = (value: T | null) => inputs.forEach(i => { i.checked = i.value === value; });
  select(initial);
  return select;
}

/** Wires the denoise switch and its neighbour count. Calls back with 0 when it's off. */
export function bindFilter(onChange: (k: number) => void): void {
  const on = byId<HTMLInputElement>('filter-on');
  const k = byId<HTMLInputElement>('filter-k');
  const out = byId<HTMLOutputElement>('filter-k-out');
  const emit = () => {
    k.disabled = !on.checked;
    out.textContent = `${k.value}/26`;
    onChange(on.checked ? Number(k.value) : 0);
  };
  on.addEventListener('change', emit);
  k.addEventListener('input', emit);
}
