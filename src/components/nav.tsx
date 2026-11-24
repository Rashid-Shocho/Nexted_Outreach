'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  ['/students', 'Students', ['/students', '/lists']],
  ['/campaigns', 'Campaigns', ['/campaigns', '/emails']],
  ['/schedule', 'Schedule', ['/schedule']],
  ['/inbox', 'Inbox', ['/inbox']],
  ['/control', 'Control', ['/control']],
  ['/rules', 'Writing rules', ['/rules']],
  ['/staff', 'Staff', ['/staff']],
] as const;

export function Nav({ unread }: { unread: number }) {
  const path = usePathname();
  return ITEMS.map(([href, label, under]) => (
    <Link key={href} href={href} className="nav" aria-current={under.some((u) => path.startsWith(u)) ? 'page' : undefined}>
      {label}
      {href === '/inbox' && unread ? <span className="badge" aria-label={`${unread} unread professor replies`}>{unread}</span> : null}
    </Link>
  ));
}
