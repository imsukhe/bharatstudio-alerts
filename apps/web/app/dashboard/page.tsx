import Link from 'next/link';
import { AppShell } from '../components/AppShell';
import DashboardClient from './DashboardClient';

export default function DashboardPage() {
  return (
    <AppShell title="Overview" actions={<Link className="secondary-button" href="/overlay/setup">Set up overlay</Link>}>
      <DashboardClient />
    </AppShell>
  );
}
