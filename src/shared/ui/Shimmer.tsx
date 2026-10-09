import * as React from 'react';

import { cn } from '@/shared/utils';

type ShimmerProps = {
  children: string;
  className?: string;
  as?: React.ElementType;
};

/**
 * Used by the chat module for streaming placeholder text and by the shared Reasoning primitive.
 * The highlight is a masked window sliding over the text while a foreground copy inside it slides
 * back by the same amount, so the copy stays aligned with the text. Only transforms animate, which
 * the compositor runs without the main thread (a moving background-position restyled every frame).
 */
export const Shimmer = React.memo<ShimmerProps>(({ children, className, as: Component = 'span' }) => {
  return (
    <Component className={cn('relative inline-block text-muted-foreground', className)}>
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 animate-shimmer-window select-none overflow-hidden [mask-image:linear-gradient(90deg,transparent_35%,#000_50%,transparent_65%)]"
      >
        <span className="block animate-shimmer-window-text text-foreground">{children}</span>
      </span>
    </Component>
  );
});
Shimmer.displayName = 'Shimmer';
