/**
 * Disclosure text for the hooks consent gate. Both surfaces show the SAME
 * in-app ask: the server ships these strings in the `hooksConsentRequest`
 * message and the webview's IntroBubble (the greeter character's speech
 * bubble) renders them verbatim on the Intro's consent step, so there is
 * exactly one copy of the terms and no client-side duplicate to drift into
 * asking for approval on weaker terms.
 *
 * Two pieces: the HEADLINE is the title of the Intro's consent step and the
 * DISCLOSURE is that step's body. The headline carries NO disclosure facts —
 * every fact lives in the shared disclosure block, so no fact depends on how a
 * surface renders its title slot (consentCopy.test.ts pins that split).
 *
 * The event count is interpolated from CLAUDE_HOOK_EVENTS, never written out:
 * a hardcoded number silently becomes a lie the next time the list changes.
 */

import { CLAUDE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.claude/settings.json';

/** WHY we ask + WHAT we write. */
export const CONSENT_FACT_WHAT =
  `Para mostrar tus sesiones en tiempo real, Pixel Agents añade hooks para ` +
  `${CLAUDE_HOOK_EVENTS.length} eventos de Claude Code en ${SETTINGS_FILE}. ` +
  `Se conserva tu configuración existente y se guarda una única copia de seguridad en settings.json${SETTINGS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops.
 *
 *  "Nothing leaves your machine" is not something this prompt can promise:
 *  `npx pixel-agents --host 0.0.0.0` binds the same server to every interface,
 *  and an accepted socket receives the store broadcasts
 *  (server/src/httpServer.ts). So it states the default and names the one
 *  thing that changes it, rather than making a promise the software can be
 *  asked to break. */
export const CONSENT_FACT_DATA =
  'Claude Code enviará esos eventos, incluidos los nombres y las entradas de las herramientas, a Pixel Agents ' +
  'en este ordenador. Los datos se mantienen en local y el servidor escucha en 127.0.0.1, salvo que ' +
  'lo inicies explícitamente con --host para exponerlo en tu red.';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'Puedes retirar los hooks en cualquier momento desde Settings → Detección instantánea (hooks).';

/** Headline for the first-run gate — the only population that is asked. A user
 *  whose hooks a pre-consent version already installed is migrated silently
 *  (the migration only ever drops events), so there is no second headline.
 *  Title of the Intro's consent step ("Welcome to Pixel Agents!" is the
 *  Intro's own opening-step title, owned by the webview). Carries NO
 *  disclosure facts by design: the facts all live in CONSENT_DISCLOSURE. */
export const CONSENT_INSTALL_HEADLINE = 'Detección de actividad en tiempo real';

/** The three disclosure facts, in order, as one block.
 *
 *  This is the consent step's body. The IntroBubble splits it on the blank
 *  lines and renders every paragraph in full on the decision surface itself — no
 *  "Details" affordance, which would put the disclosure one click away from
 *  the decision it is there to inform. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
