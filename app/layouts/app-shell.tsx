import { Outlet } from "react-router";

import { Header } from "~/components/header";

// Placeholder auth boundary. Real session/middleware guard lands in
// Phase 3 (Better Auth on D1); this shell renders unconditionally for now.
export default function AppLayout() {
  return (
    <div>
      <Header />
      <Outlet />
    </div>
  );
}
