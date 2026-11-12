/** Shared with CLI preparation. Display names may contain Spanish text and punctuation. */
export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_SLUG_MAX_LENGTH = 48;

export function validProjectName(name: string): boolean {
  return (
    !!name.trim() &&
    name.length <= PROJECT_NAME_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(name)
  );
}

export function projectSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/^-|-$/g, '');
}

export function validProjectSlug(slug: string): boolean {
  return (
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug)
  );
}

const stopWords = new Set(
  'a al algo como con de del desde el en es esta este esto la las lo los para por que se sin su un una unos unas y o quiero queremos necesito crear hacer tener poder proyecto idea respuestas supuestos ninguno ninguna the and for with from this that want build create'.split(
    ' ',
  ),
);

/** Frequency-ranked keywords, with first appearance breaking ties. No model or network. */
export function projectNameProposals(context: string): string[] {
  const words = projectSlugWords(context);
  const frequencies = new Map<string, number>();
  for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  const ranked = [...frequencies].sort((left, right) => right[1] - left[1]);
  // Keep room for a suffix even with an unusually long keyword.
  const base = ranked.slice(0, 3).map(([word]) => word.slice(0, 16));
  if (!base.length) return ['nuevo-proyecto', 'mi-proyecto'];
  const candidates = [base.join('-'), base.slice(0, 2).join('-'), base[0], `${base[0]}-proyecto`];
  return [...new Set(candidates.map(projectSlug).filter(validProjectSlug))].slice(0, 4);
}

function projectSlugWords(context: string): string[] {
  return context
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !stopWords.has(word) && validProjectSlug(word));
}
