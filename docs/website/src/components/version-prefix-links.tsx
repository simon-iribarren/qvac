'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { getVersionFromPath } from '@/lib/versions';

/**
 * Wraps the docs layout and rewrites internal sidebar link clicks
 * to preserve the current version prefix.
 *
 * The sidebar tree is built with unversioned (latest) paths like /sdk, /welcome.
 * When browsing /v0.6.1/welcome, clicking /sdk in the sidebar should go to
 * /v0.6.1/sdk — not back to the latest /sdk.
 *
 * This component intercepts click events on <a> elements within the sidebar
 * and rewrites their href at navigation time.
 */
export function VersionPrefixLinks({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);

  const currentVersion = getVersionFromPath(pathname);

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (!currentVersion) return;

      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      if (href.startsWith(`/${currentVersion}/`)) return;
      if (/^\/v\d+\.\d+\.\d+\//.test(href)) return;
      if (anchor.getAttribute('target') === '_blank') return;

      e.preventDefault();
      const versionedHref = `/${currentVersion}${href}`;
      window.location.href = versionedHref;
    },
    [currentVersion],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !currentVersion) return;

    el.addEventListener('click', handleClick, true);
    return () => el.removeEventListener('click', handleClick, true);
  }, [currentVersion, handleClick]);

  return <div ref={containerRef}>{children}</div>;
}
