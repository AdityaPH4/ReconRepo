import Link from 'next/link';

/** Home-page card for one module. `badge` shows a live pending-count pill, top-right — used by anything that needs attention. */
export function ModuleCard({
  href,
  icon,
  title,
  description,
  badge,
}: {
  href: string;
  icon: string;
  title: string;
  description: string;
  badge?: number;
}) {
  return (
    <Link href={href} className="card block hover:border-accent transition-colors relative">
      {badge != null && badge > 0 && <span className="badge badge-err absolute top-4 right-4">{badge}</span>}
      <div className="card-body">
        <div className="text-[32px] mb-3">{icon}</div>
        <h2 className="text-lede font-semibold mb-2">{title}</h2>
        <p className="text-body text-ink-3 leading-relaxed">{description}</p>
        <p className="text-body font-semibold text-accent mt-4">Open →</p>
      </div>
    </Link>
  );
}
