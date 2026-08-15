import Link from 'next/link';

export function TopNav() {
  return (
    <nav className="top-nav" aria-label="Primary navigation">
      <Link className="brand" href="/">BharatStudio Alerts</Link>
      <div className="nav-links">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/companion">Companion</Link>
        <Link href="/overlay/setup">Overlay</Link>
        <Link className="nav-action" href="/login">Sign in</Link>
      </div>
    </nav>
  );
}
