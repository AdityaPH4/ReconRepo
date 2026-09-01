import Link from 'next/link';
import { AdminLink } from '@/components/admin/AdminLink';

/**
 * Landing hub — picks which of the two modules to open.
 *
 * Payment Reconciliation (Layer 1, ported from `reconciliation (68).html`)
 * lives at `/recon`; MPR Reconciliation (Layer 2, ported from
 * `mpr-recon (10).html`) lives at `/mpr`. Both are genuinely separate tools
 * in the legacy codebase — this hub is the one thing that's new, giving a
 * single entry point into either without changing what either module does.
 */
export default function HomePage() {
  return (
    <main className="app-main">
      <div className="results-header mt-6">
        <div>
          <h1 className="results-title">Toit Reconciliation</h1>
          <div className="results-meta">
            <span className="pill">Pick a module to continue</span>
          </div>
        </div>
        <AdminLink />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6">
        <ModuleCard
          href="/recon"
          icon="🧾"
          title="Payment Reconciliation"
          description="Per-outlet, per-business-date reconciliation: upload the Payment Report, Pinelabs ZIP, drawer summary and (optionally) the HDFC UPI statement, resolve remarks, and submit."
        />
        <ModuleCard
          href="/mpr"
          icon="🏦"
          title="MPR Reconciliation"
          description="Layer-2 check: confirms a submitted session's settlement ledger against the actual bank settlement files (Kotak, Pinelabs, AMEX, HDFC UPI)."
        />
      </div>
    </main>
  );
}

function ModuleCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="card block hover:border-accent transition-colors">
      <div className="card-body">
        <div className="text-[32px] mb-3">{icon}</div>
        <h2 className="text-lede font-semibold mb-2">{title}</h2>
        <p className="text-body text-ink-3 leading-relaxed">{description}</p>
        <p className="text-body font-semibold text-accent mt-4">Open →</p>
      </div>
    </Link>
  );
}
