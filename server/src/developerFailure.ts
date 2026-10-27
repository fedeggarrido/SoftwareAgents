/** Structured diagnostics shared by guards, retry admission and task readers. */
export class ChangeZonesExceededError extends Error {
  readonly category = 'change_zones_exceeded';
  readonly paths: string[];

  constructor(paths: string[]) {
    const safe = [...new Set(paths)].sort();
    super(`Developer changeZones exceeded: ${JSON.stringify(safe)}; human review required`);
    this.paths = safe;
  }

  diagnostic(): string {
    return `Developer failed: ${JSON.stringify({ category: this.category, paths: this.paths })}`;
  }
}

export class MissingTestError extends Error {
  readonly category = 'missing_test';

  constructor() {
    super('Developer requires an added or adjusted acceptance/reproduction test');
  }

  diagnostic(): string {
    return `Developer failed: ${JSON.stringify({ category: this.category, paths: [] })}`;
  }
}

export class DeveloperGuardError extends Error {
  readonly category = 'guard:developer_changes';

  diagnostic(): string {
    return `Developer failed: ${JSON.stringify({ category: this.category, paths: [], detail: this.message })}`;
  }
}

export function developerGuardFailure(reason: string | null | undefined) {
  if (!reason?.startsWith('Developer failed: ')) return null;
  try {
    const data = JSON.parse(reason.slice('Developer failed: '.length)) as {
      category: string;
      paths: string[];
      detail?: string;
      gate?: string;
    };
    return ['change_zones_exceeded', 'missing_test', 'guard:developer_changes'].includes(
      data.category,
    ) &&
      Array.isArray(data.paths) &&
      data.paths.every((file) => typeof file === 'string')
      ? data
      : null;
  } catch {
    return null;
  }
}
