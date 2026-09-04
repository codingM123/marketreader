/**
 * Two experiences, one product.
 *
 * `/` explains why this is a different problem from "show me prices". The six
 * routes under `/watch`, `/lab` and `/system` are the product itself. The split
 * exists because depth that takes twenty minutes to find is worth the same as
 * depth that is not there — and none of those six is padding: each shows work
 * the server already does and previously had nowhere to put. The test a route
 * had to pass: delete it, and a real capability stops being reachable.
 */
import { useEffect, useState } from "react";
import { Landing } from "./landing/Landing.js";
import { useRouter } from "./router.js";
import { WorkspaceProvider } from "./workspace/data.js";
import { DigestPage } from "./workspace/Digest.js";
import { AllSymbolsPage, HeldBackPage, HistoryPage, SystemPage } from "./workspace/Pages.js";
import { LabPage } from "./workspace/LabPage.js";
import { Shell } from "./workspace/Shell.js";
import { Link } from "./router.js";

export default function App() {
  const { path } = useRouter();

  if (path === "/" || path === "") return <Landing />;

  return (
    <WorkspaceProvider>
      <Route path={path} />
    </WorkspaceProvider>
  );
}

/**
 * The lab, only where the server will actually answer it.
 *
 * Hiding the sidebar link was half a fix. The route stayed live, so a bookmark,
 * a typed URL or a back button under `MODE=live` landed on exactly the screen
 * the hiding exists to prevent: every button 404ing in silence.
 */
function LabGate() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    void fetch("/api/status")
      .then((r) => r.json())
      .then((s: { lab?: boolean }) => setAvailable(s.lab !== false))
      .catch(() => setAvailable(true));
  }, []);

  if (available === null) return <Shell title="Lab" lede="Checking whether this server serves the lab."><p className="loading">One moment…</p></Shell>;
  if (available) return <LabPage />;
  return (
    <Shell title="Lab" lede="Not available on this server.">
      <p className="loading">
        The lab rewinds watermarks and injects faults, so its routes are not registered under{" "}
        <code>MODE=live</code> — not refused, absent. Restart in replay mode, or set{" "}
        <code>LAB=1</code>, to open it. <Link to="/watch">Back to the digest</Link>
      </p>
    </Shell>
  );
}

function Route({ path }: { path: string }) {
  switch (path) {
    case "/watch":
      return <DigestPage />;
    case "/watch/all":
      return <AllSymbolsPage />;
    case "/watch/held-back":
      return <HeldBackPage />;
    case "/watch/history":
      return <HistoryPage />;
    case "/lab":
      return <LabGate />;
    case "/system":
      return <SystemPage />;
    default:
      return (
        <Shell title="Not found" lede={`Nothing lives at ${path}.`}>
          <p className="loading">
            <Link to="/watch">Back to the digest</Link>
          </p>
        </Shell>
      );
  }
}
