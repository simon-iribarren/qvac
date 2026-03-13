'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { Node } from 'fumadocs-core/page-tree';
import { getVersionFromPath } from '@/lib/versions';

function shouldPrefix(url: string | undefined): boolean {
  if (!url || !url.startsWith('/')) return false;
  if (url === '/') return false;
  if (url.startsWith('/#')) return false;
  return true;
}

function prefixTreeUrls(nodes: Node[], prefix: string): Node[] {
  return nodes.map((node) => {
    if (node.type === 'separator') return node;

    if (node.type === 'page') {
      const url = shouldPrefix(node.url)
        ? `${prefix}${node.url}`
        : node.url;
      return { ...node, url };
    }

    if (node.type === 'folder') {
      const children = prefixTreeUrls(node.children, prefix);
      const index = node.index
        ? {
            ...node.index,
            url: shouldPrefix(node.index.url)
              ? `${prefix}${node.index.url}`
              : node.index.url,
          }
        : undefined;
      return { ...node, children, index };
    }

    return node;
  });
}

/**
 * Wraps DocsLayout and rewrites sidebar tree URLs with the current
 * version prefix so that Fumadocs natively handles active state,
 * folder expansion, and navigation for versioned pages.
 */
export function VersionedDocsLayout({
  tree,
  children,
  ...props
}: React.ComponentProps<typeof DocsLayout>) {
  const pathname = usePathname();
  const currentVersion = getVersionFromPath(pathname);

  const versionedTree = useMemo(() => {
    if (!currentVersion || !tree) return tree;

    const prefix = `/${currentVersion}`;
    return {
      ...tree,
      children: prefixTreeUrls(tree.children, prefix),
    };
  }, [tree, currentVersion]);

  return (
    <DocsLayout {...props} tree={versionedTree}>
      {children}
    </DocsLayout>
  );
}
