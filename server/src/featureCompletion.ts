/** Shared completion evidence for the feature list and the readable plan. */
export function featureMerged(
  key: string,
  tasks: readonly { status?: unknown }[],
  run: { branch?: unknown; head?: unknown } | null | undefined,
  mainAncestors: ReadonlySet<string> | undefined,
): boolean {
  return (
    tasks.length > 0 &&
    tasks.every((task) => task.status === 'DONE') &&
    run?.branch === `sa/${key}-integration` &&
    typeof run.head === 'string' &&
    mainAncestors?.has(run.head) === true
  );
}
