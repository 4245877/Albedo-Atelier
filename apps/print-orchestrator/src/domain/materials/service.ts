import type { Material } from "./types";

export function describeMaterial(material: Material): string {
  return [material.manufacturer, material.name, material.color].filter(Boolean).join(" ");
}
