/** Extract "major.minor" from a semver string (e.g. "1.1.1" → "1.1") */
export function toMajorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

export const PROJECT_URL = 'https://github.com/fedeggarrido/SoftwareAgents';

/** SoftwareAgents is a fork: this attribution must stay visible (MIT). */
export const UPSTREAM_URL = 'https://github.com/pixel-agents-hq/pixel-agents';

export const upstreamContributors: ReadonlyArray<{ name: string; url: string }> = [
  { name: '@balgaly', url: 'https://github.com/balgaly' },
  { name: '@bezzborodth-tech', url: 'https://github.com/bezzborodth-tech' },
  { name: '@Commandershadow9', url: 'https://github.com/Commandershadow9' },
  { name: '@d4rkd0s', url: 'https://github.com/d4rkd0s' },
  { name: '@daniel-dallimore', url: 'https://github.com/daniel-dallimore' },
  { name: '@dankadr', url: 'https://github.com/dankadr' },
  { name: '@drewf', url: 'https://github.com/drewf' },
  { name: '@elietwd', url: 'https://github.com/elietwd' },
  { name: '@ErickGross-19', url: 'https://github.com/ErickGross-19' },
  { name: '@florintimbuc', url: 'https://github.com/florintimbuc' },
  { name: '@itsManeka', url: 'https://github.com/itsManeka' },
  { name: '@marctebo', url: 'https://github.com/marctebo' },
  { name: '@mitre88', url: 'https://github.com/mitre88' },
  { name: '@NNTin', url: 'https://github.com/NNTin' },
  { name: '@noam971', url: 'https://github.com/noam971' },
  { name: '@pablodelucca', url: 'https://github.com/pablodelucca' },
  { name: '@Ralphive', url: 'https://github.com/Ralphive' },
  { name: '@snvtac', url: 'https://github.com/snvtac' },
  { name: '@srasantos', url: 'https://github.com/srasantos' },
  { name: '@ZenidX', url: 'https://github.com/ZenidX' },
];
