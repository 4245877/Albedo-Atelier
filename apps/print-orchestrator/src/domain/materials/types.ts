export type MaterialKind = "filament" | "resin";

export interface Material {
  id: string;
  name: string;
  kind: MaterialKind;
  color?: string;
  manufacturer?: string;
}
