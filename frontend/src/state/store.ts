import { create } from "zustand";

export interface AppState {
  selectedRegulator: string | null;
  selectedBindingDatasets: string[];
  selectedPerturbationDatasets: string[];
  topN: number;
  effectThreshold: number;
  pvalueThreshold: number;
  filtersJson: string; // raw `?filters=` JSON; opaque to store
  set: (patch: Partial<Omit<AppState, "set">>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedRegulator: null,
  selectedBindingDatasets: [],
  selectedPerturbationDatasets: [],
  topN: 25,
  effectThreshold: 0,
  pvalueThreshold: 0.05,
  filtersJson: "",
  set: (patch) => set(patch),
}));
