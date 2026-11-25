import { PROJECT_URL, UPSTREAM_URL, upstreamContributors } from '../changelogData.ts';
import { es } from '../i18n/es.js';
import { Modal } from './ui/Modal.js';

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function ChangelogModal({ isOpen, onClose }: ChangelogModalProps) {
  const copy = es.changelog;
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={copy.title} className="changelog-dialog">
      <div className="changelog-body">
        {copy.sections.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <ul>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
        <section>
          <h3>{copy.about}</h3>
          <p>{copy.attribution}</p>
          <p className="changelog-links">
            <ExternalLink href={PROJECT_URL}>{copy.project}</ExternalLink>
            <ExternalLink href={`${PROJECT_URL}/blob/main/LICENSE`}>{copy.license}</ExternalLink>
            <ExternalLink href={UPSTREAM_URL}>{copy.upstream}</ExternalLink>
          </p>
          <details>
            <summary>{copy.contributors}</summary>
            <ul>
              {upstreamContributors.map(({ name, url }) => (
                <li key={name}>
                  <ExternalLink href={url}>{name}</ExternalLink>
                </li>
              ))}
            </ul>
          </details>
        </section>
      </div>
    </Modal>
  );
}
