import { Link } from "react-router";

import { Wordmark } from "./wordmark";

export function Header() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl items-center px-4 py-4">
        <Link to="/" aria-label="Foxhound home">
          <Wordmark />
        </Link>
      </div>
    </header>
  );
}
