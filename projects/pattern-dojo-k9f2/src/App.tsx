import { useHashRoute, href } from "./lib/router";
import Home from "./pages/Home";
import PatternDetail from "./pages/PatternDetail";
import Roadmap from "./pages/Roadmap";
import Quiz from "./pages/Quiz";

const NAV = [
  { path: "/", label: "Patterns" },
  { path: "/roadmap", label: "Roadmap" },
  { path: "/quiz", label: "Trainer" },
];

export default function App() {
  const seg = useHashRoute();
  const route = seg[0] ?? "";

  let page;
  if (route === "pattern" && seg[1]) page = <PatternDetail id={seg[1]} />;
  else if (route === "roadmap") page = <Roadmap />;
  else if (route === "quiz") page = <Quiz />;
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
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main>{page}</main>

      <footer className="footer">
        <div className="container">
          <span>Pattern Dojo — intuition-first prep for the NeetCode 150 patterns.</span>
          <span>Built for learning, not memorizing. Progress saved locally.</span>
        </div>
      </footer>
    </div>
  );
}
