/**
 * Whether a slicer G-code flavor is plausible for a printer protocol. One shared
 * rule for the slicing-set validator and the scheduling compatibility matrix, so
 * the two can never drift (they previously carried identical private copies).
 *
 * Unknown protocols never complain — the check only flags a concrete
 * contradiction, not missing knowledge.
 */
export function gcodeFlavorFitsProtocol(flavor: string, protocol: string): boolean {
  const f = flavor.toLowerCase();
  const expected: Record<string, string[]> = {
    moonraker: ["klipper", "reprapfirmware", "marlin"],
    creality: ["klipper", "marlin"],
    bambu: ["marlin", "bbl", "klipper"]
  };
  const allowed = expected[protocol.toLowerCase()];
  if (!allowed) return true; // unknown protocol → don't complain
  return allowed.some((a) => f.includes(a));
}
