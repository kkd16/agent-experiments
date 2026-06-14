import { useHashRoute, href } from "./lib/router";
import Home from "./pages/Home";
import PatternDetail from "./pages/PatternDetail";
import Roadmap from "./pages/Roadmap";
import Quiz from "./pages/Quiz";
import Review from "./pages/Review";
import Cheatsheet from "./pages/Cheatsheet";
import Stats from "./pages/Stats";
import CommandPalette from "./components/CommandPalette";
import { useTheme } from "./lib/theme";
import { useSRS } from "./lib/srs";

const NAV = [
  { path: "/", label: "Patterns" },
  { path: "/review", label: "Review" },
  { path: "/roadmap", label: "Roadmap" },
  { path: "/quiz", label: "Trainer" },
  { path: "/cheatsheet", label: "Cheat-sheet" },
  { path: "/stats", label: "Stats" },
];

export default function App() {
  const seg = useHashRoute();
  const route = seg[0] ?? "";
  const { theme, toggle } = useTheme();
  const { counts } = useSRS();

  let page;
  if (route === "pattern" && seg[1]) page = <PatternDetail id={seg[1]} />;
  else if (route === "roadmap") page = <Roadmap />;
  else if (route === "quiz") page = <Quiz />;
  else if (route === "review") page = <Review />;
  else if (route === "cheatsheet") page = <Cheatsheet />;
  else if (route === "stats") page = <Stats />;
  else page = <Home />;

  const isActive = (path: string) => {
    if (path === "/") return route === "" || route === "pattern";
    return `/${route}` === path;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="container topbar-inner">
          <a className="brand" href={href("/")}>
            <span className="logo">◆</span>
            Pattern Dojo
          </a>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.path} className={isActive(n.path) ? "active" : ""} href={href(n.path)}>
                {n.label}
                {n.path === "/review" && counts.due > 0 && (
                  <span className="due-dot" title={`${counts.due} due`}>{counts.due}</span>
                )}
              </a>
            ))}
          </nav>
          <div className="topbar-actions">
            <button
              className="icon-btn"
              onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              title="Command palette (⌘K)"
              aria-label="Open command palette"
            >
              ⌕
            </button>
            <button
              className="icon-btn"
              onClick={toggle}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </div>
      </header>

      <main>{page}</main>

      <footer className="footer">
        <div className="container">
          <span>Pattern Dojo — intuition-first prep for the NeetCode 150 patterns.</span>
          <span>Built for learning, not memorizing. Press ⌘K to jump anywhere.</span>
        </div>
      </footer>

      <CommandPalette />
    </div>
  );
}
