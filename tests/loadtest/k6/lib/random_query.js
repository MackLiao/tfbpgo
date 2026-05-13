const POPULAR_REGULATORS = ['YBR289W', 'YML007W', 'YPL248C', 'YOR028C', 'YGL073W'];
const VARIED_REGULATORS  = [
  'YDR277C','YAL038W','YMR053C','YHR084W','YJL056C','YKL062W','YPR065W',
  'YGL013C','YBR234C','YDL106C','YLR131C','YOR077W','YNL216W','YMR043W',
];
const BINDING_DATASETS      = ['callingcards','harbison'];
const PERTURBATION_DATASETS = ['hackett'];

export function popularRegulator(rng) {
  return POPULAR_REGULATORS[Math.floor(rng * POPULAR_REGULATORS.length)];
}
export function variedRegulator(rng) {
  return VARIED_REGULATORS[Math.floor(rng * VARIED_REGULATORS.length)];
}
export function pickBindingDataset(rng) {
  return BINDING_DATASETS[Math.floor(rng * BINDING_DATASETS.length)];
}
export function pickPerturbationDataset(rng) {
  return PERTURBATION_DATASETS[Math.floor(rng * PERTURBATION_DATASETS.length)];
}
