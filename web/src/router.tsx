/**
 * Routing, without a dependency.
 *
 * Seven static paths -- an overview and the six workspace routes -- with no
 * parameters and no nested layouts beyond one shell. A
 * router library would be the conventional answer and would be more code than
 * this, not less — and "where to keep things simple versus add complexity" is
 * one of the questions this build is meant to answer. The trade is real and
 * small: no route params, no data loaders, no lazy boundaries. If any of those
 * were needed, this would become a dependency rather than grow.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

interface RouterValue {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue>({ path: "/", navigate: () => {} });

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname || "/");

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

/**
 * An anchor that navigates without a reload, and still behaves like an anchor:
 * middle-click, ctrl-click and "open in new tab" all keep working, because the
 * href is real and only a plain left-click is intercepted.
 */
export function Link({
  to,
  className,
  children,
  onClick,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** True when `path` is the active route for a nav item at `to`. */
export function isActive(path: string, to: string, exact = false): boolean {
  if (exact) return path === to;
  return path === to || path.startsWith(to + "/");
}
