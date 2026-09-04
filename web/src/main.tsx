import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { RouterProvider } from "./router.js";
import "./styles.css";
import "./shell.css";

/**
 * The overview forces dark and the workspace follows the reader.
 *
 * Set on the document so the scrollbar and overscroll match the page rather
 * than the OS. Kept in sync with the route because a stale value here would
 * paint a light gutter beside a dark page, which is the exact defect this
 * exists to remove.
 */
function syncCanvas() {
  const dark = window.location.pathname === "/" || window.location.pathname === "";
  document.documentElement.style.colorScheme = dark ? "dark" : "";
}
syncCanvas();
window.addEventListener("popstate", syncCanvas);
const push = history.pushState.bind(history);
history.pushState = ((...args: Parameters<typeof history.pushState>) => {
  push(...args);
  syncCanvas();
}) as typeof history.pushState;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider>
      <App />
    </RouterProvider>
  </StrictMode>,
);
