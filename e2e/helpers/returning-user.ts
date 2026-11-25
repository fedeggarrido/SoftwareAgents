import { version } from '../../package.json';

/** A returning user: no first-visit guide and no update notice cover the office. */
export const SEEN_VERSION = version.split('.').slice(0, 2).join('.');
