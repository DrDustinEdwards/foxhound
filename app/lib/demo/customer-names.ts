import { pick, seededInt } from "./customer-base";

const FIRST_NAMES = [
  "Alex",
  "Bailey",
  "Carmen",
  "Devin",
  "Elena",
  "Felix",
  "Grace",
  "Hassan",
  "Iris",
  "Jordan",
  "Kai",
  "Luna",
  "Mateo",
  "Nadia",
  "Owen",
  "Priya",
  "Quincy",
  "Rosa",
  "Sam",
  "Tara",
  "Uma",
  "Vince",
  "Willa",
  "Xavier",
  "Yara",
  "Zane",
  "Amir",
  "Brielle",
  "Caleb",
  "Dahlia",
  "Esme",
  "Finn",
  "Greta",
  "Hugo",
  "Imani",
  "Jace",
  "Kira",
  "Leo",
  "Mira",
  "Nico",
] as const;
const LAST_NAMES = [
  "Adler",
  "Burke",
  "Castro",
  "Dalton",
  "Esparza",
  "Fields",
  "Gomez",
  "Hayes",
  "Iverson",
  "Jansen",
  "Kapoor",
  "Lowe",
  "Marsh",
  "Nakamura",
  "Oduya",
  "Pace",
  "Quinn",
  "Rojas",
  "Stein",
  "Tomlin",
  "Underwood",
  "Vega",
  "Wexler",
  "Xu",
  "Young",
  "Zara",
  "Abramov",
  "Beck",
  "Choi",
  "Diaz",
] as const;
export const TEAMFLOW_COMPANY_PREFIXES = [
  "North",
  "South",
  "East",
  "West",
  "Bright",
  "Iron",
  "Silver",
  "Cedar",
  "Maple",
  "Pine",
  "Oak",
  "Ridge",
  "Stone",
  "River",
  "Lake",
  "Bay",
  "Coast",
  "Field",
  "Forge",
  "Cobalt",
  "Summit",
  "Slate",
  "Crimson",
  "Ember",
] as const;
export const TEAMFLOW_COMPANY_SUFFIXES = [
  "Labs",
  "Works",
  "Group",
  "Studio",
  "Co",
  "Stack",
  "Logic",
  "Loop",
  "Cloud",
  "Forge",
  "Build",
  "Sync",
  "Flow",
  "Grid",
  "Hub",
  "Core",
] as const;
export const BOLT_COMPANY_PREFIXES = [
  "Apex",
  "Beacon",
  "Cipher",
  "Drift",
  "Echo",
  "Flux",
  "Glyph",
  "Hex",
  "Iota",
  "Jolt",
  "Kelp",
  "Loft",
  "Mesh",
  "Nexa",
  "Orbit",
  "Pulse",
  "Quark",
  "Relay",
  "Sigma",
  "Tally",
  "Unit",
  "Vector",
  "Wave",
  "Xen",
] as const;
export const BOLT_COMPANY_SUFFIXES = [
  "Stack",
  "Logic",
  "IO",
  "Engine",
  "Lab",
  "Compute",
  "Probe",
  "Trace",
  "Pipe",
  "Grid",
  "Cloud",
  "Ops",
  "Metric",
  "Sense",
  "Pulse",
  "Build",
] as const;

function generateName(
  seed: string,
  companyBiasPct: number,
  prefixes: readonly string[],
  suffixes: readonly string[],
): string {
  if (seededInt(`${seed}:kind`, 100) < companyBiasPct) {
    const prefix = pick(`${seed}:cprefix`, prefixes);
    const suffix = pick(`${seed}:csuffix`, suffixes);
    return `${prefix}${suffix}`;
  }
  const first = pick(`${seed}:first`, FIRST_NAMES);
  const last = pick(`${seed}:last`, LAST_NAMES);
  return `${first} ${last}`;
}

/**
 * Reroll the anonymous-customer name if it collides with a scripted customer
 * name. `reserved` is built from the scripted customers in the base. Rerolls up
 * to 5 times with sub-seed variations; final fallback appends " II" so the
 * function always returns a non-colliding string.
 */
export function generateNameNoCollision(
  seed: string,
  companyBiasPct: number,
  prefixes: readonly string[],
  suffixes: readonly string[],
  reserved: Set<string>,
): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const subSeed = attempt === 0 ? seed : `${seed}:retry${attempt}`;
    const name = generateName(subSeed, companyBiasPct, prefixes, suffixes);
    if (!reserved.has(name)) return name;
  }
  return `${generateName(`${seed}:retry-final`, companyBiasPct, prefixes, suffixes)} II`;
}

export function emailFromName(name: string, customerId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `${slug}@${customerId}.demo`;
}
