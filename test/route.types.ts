import type { Route, RouteKind } from '../src/route.ts';

// Must stay an error: if a reject variant is ever added, this compiles and tsc --noEmit fails.
// @ts-expect-error
export const rejectedRoute: Route = { kind: 'reject' };

// @ts-expect-error
export const rejectedKind: RouteKind = 'reject';
